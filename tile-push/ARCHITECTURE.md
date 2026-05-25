# tile-push Architecture

This document describes the current multi-tenant production architecture and how it works end-to-end. Read this when you need to understand what runs where, why it's structured the way it is, or how to change it.

**Companion doc:** [`GCP_INFRASTRUCTURE.md`](./GCP_INFRASTRUCTURE.md) — exhaustive resource-by-resource inventory of every GCP entity. Read that when you need to know the exact resource name, gcloud command, or rollback step.

## High-level diagram

```
                                        ┌─ DEPLOY PATH ──────────────────┐
                                        │ Developer machine              │
                                        │  $ npx tile-push deploy        │
                                        │   1. POST /api/cli/.../upload- │
                                        │      url → signed PUT URL      │
                                        │   2. PUT bytes direct to GCS   │
                                        │      (bypasses LB)             │
                                        │   3. POST /api/cli/.../bundles │
                                        │      → Firestore commit        │
                                        │   4. Cloud CDN invalidate      │
                                        │      /api/check-update/v2/     │
                                        │      t/{appId}/*               │
                                        └──────────────┬─────────────────┘
                                                       │
                                                       ▼
                                              gs://tile-push-bundles/
                                              t/{appId}/{bundleId}/
                                                bundle.zip + assets
                                              Cache-Control: max-age=
                                                31536000, immutable
                                                       │
                                                       │
┌──────────────────┐                                   │
│ React Native app │                                   │
│  TilePush.wrap   │                                   │
│  ({appId})       │     READ PATH                     │
│                  │     baseURL = ota.tile.dev        │
│ GET ota.tile.dev/│ ─── HTTPS ───▶                    │
│ api/check-update/│                                   │
│ v2/t/{appId}/... │                AWS Route 53 DNS   │
└────────┬─────────┘                ota.tile.dev → A → │
         │                          8.233.151.195      │
         │                                  │          │
         │                                  ▼          │
         │                        Google Cloud LB      │
         │                        (global static IP)   │
         │                        + Google-managed SSL │
         │                        cert (tile-push-     │
         │                         cert-v2)            │
         │                                  │          │
         │                                  ▼          │
         │                        URL map: path-routed │
         │      ┌───────────────────────────┼─────────────────────┐
         │      │                           │                     │
         │ /api/check-update/*    /api/cli/*, /ping        /* (default)
         │      │                           │                     │
         │      ▼                           ▼                     ▼
         │  backend-checkupdate       backend-admin       backend-bundles
         │  Cloud CDN ON              Cloud CDN OFF       Cloud CDN ON
         │  s-maxage=30d              no-store            max-age=1yr
         │  invalidate per tenant     Vary: Auth          immutable
         │  query string excluded                        (GCS bucket)
         │  from cache key                                       │
         │      │                           │                    ▼
         │      └────► Serverless NEG ◄─────┘             gs://tile-push-
         │             tile-push-neg                       bundles
         │                  │                              (public-read,
         │                  ▼                              same bucket as
         │           Cloud Run service:                    deploy path)
         │           tile-push (us-central1)
         │                  │
         │      ┌───────────┴───────────┐
         │      ▼                       ▼
         │  Layer 2: tenant         Layer 4: Hono router
         │  middleware              → upstream handler
         │  (AsyncLocalStorage)         │
         │                              ▼
         │                       firebaseDatabase plugin
         │                       (reads appId from ALS,
         │                        adds .where("app_id"...))
         │                              │
         │                              ▼
         │                       Firestore (named DB: tile-push)
         │                         collection: bundles
         │                         every doc has app_id field
         │                         every composite index has
         │                         app_id as first column
         │
         ▼
   https://ota.tile.dev/t/{appId}/{bundleId}/bundle.zip
   (Cloud CDN edge → GCS, immutable, ~5ms on cache hit)
```

**Fallback still alive:** `https://apptile-staging-setup.web.app/api/**` continues to work via Firebase Hosting → same Cloud Run service. Old SDK builds that haven't been rebuilt against `ota.tile.dev` keep working.

## Tech stack

| Layer | Tech | Why this choice |
|---|---|---|
| Domain | `ota.tile.dev` (subdomain of tile.dev, A record on AWS Route 53) | Stable customer-facing URL, DNS-portable so we can move backends without app rebuild |
| CDN / edge cache | Google Cloud CDN behind a Global External HTTPS LB | Explicit per-tenant invalidation on deploy, 30d edge TTL, query string excluded from cache key. Same edge fleet as Firebase Hosting but with control over invalidation and TTLs. |
| Load Balancer | Global External HTTPS LB with serverless NEG → Cloud Run | Path-based routing splits cacheable check-update from non-cacheable CLI from immutable bundle bytes. ~$18/mo + ~$0.008/GB. |
| SSL | Google-managed cert (`tile-push-cert-v2`), DNS-validated | Free, auto-renews. Provisions only after DNS is correctly set up (lesson learned the hard way). |
| Function runtime | Firebase Cloud Functions Gen 2 (Cloud Run under the hood) | Auto-scales 0→N, native Firebase integration, GCP credits apply |
| Web framework | Hono (inside the function) + Express (provided by Google's Functions Framework) | Hono is runtime-portable; Express is what Cloud Functions speaks. A small adapter bridges them. |
| Tenant context propagation | Node.js `AsyncLocalStorage` | Per-request store visible to deeply nested async code without parameter threading. Upstream code stays untouched. |
| In-instance cache | Module-level `Map<string, CacheEntry>` with TTL | Per-warm-instance burn cache, mostly redundant now that Cloud CDN absorbs the bulk of reads. Kept for cheap insurance. |
| Database | Firestore Native mode, named database `tile-push` | NoSQL doc store, auto-scales to billions of docs, GCP credits cover it. Note: Admin SDK bypasses Security Rules, so tenant isolation is enforced at the plugin layer. |
| Bundle storage | GCS (`tile-push-bundles` bucket, public-read, tenant-prefixed, immutable Cache-Control on every object) | Same project, lowest config friction. Public-read removes signBlob bottleneck. Tenant prefix lets us cleanly delete a tenant's data with a single recursive `rm`. Served via Cloud CDN backend bucket. Will migrate to Cloudflare R2 later. |
| Cache invalidation | Cloud CDN `urlMaps.invalidateCache` API, called from Cloud Run after every successful deploy | Tenant-scoped path pattern: `/api/check-update/v2/t/{appId}/*`. <60s typical propagation, 1000/mo free quota. |
| Fallback URL | Firebase Hosting at `apptile-staging-setup.web.app` | Kept alive so old SDK builds (apptile-seed, tilepacket) keep working while we transition consumers to `ota.tile.dev`. Decommission ~1 week post-cutover. |
| Build | `tsdown` (TypeScript bundler using rolldown) | Used by the upstream hot-updater repo; bundles everything except `firebase-functions` + `firebase-admin` |
| Deploy CLI | `firebase` (firebase-tools) | Standard Firebase deploy tool — handles function provisioning, IAM, indexes, hosting |

## What's actually running

When a request hits `https://ota.tile.dev/api/check-update/v2/t/{appId}/fingerprint/...`, this is the full call chain:

```
[User device]
   │  HTTPS request → DNS resolves ota.tile.dev → 8.233.151.195
   ▼
[Global External HTTPS Load Balancer]
   │  TLS termination at nearest Google edge POP (tile-push-cert-v2)
   │  URL map: ota.tile.dev/api/check-update/* → backend-checkupdate
   │
[Cloud CDN — at the edge POP]
   │  Cache key: (host, path) — query string EXCLUDED
   │  Cache lookup:
   │   ├─ HIT  → serve from edge cache (~5ms total)
   │   └─ MISS → cache fill from origin (Cloud Run)                  ─┐
                                                                      │
[backend-checkupdate's serverless NEG] ◀──────────────────────────────┘
   │  Routes to Cloud Run service "tile-push" (us-central1)
   │
   ▼
[Container running our bundled index.cjs]
   │
   ├─ Layer 1: Google's Functions Framework (Express server)
   │     Listens on PORT env var
   │     Catches all requests, routes them to our function export
   │
   ├─ Layer 2: onRequest() adapter (in our code)
   │     Converts Express (req, res) → Web Request
   │     Adds Cache-Control header to response based on path:
   │       /api/check-update/* → public, max-age=60, s-maxage=2592000
   │       /api/cli/*          → private, no-store + Vary: Authorization
   │
   ├─ Layer 2.5: TENANT MIDDLEWARE (in our code) — multi-tenant gate
   │     Match URL: /api/check-update/v2/t/{appId}/(.+)
   │     Validate appId format (isValidAppId)
   │     Strip /t/{appId} from URL
   │     tenantALS.run({ appId }, async () => { ... rest ... })
   │
   ├─ Layer 3: In-memory cache check (in our code)
   │     Cache key: `${appId}|${url.pathname}`
   │     Mostly redundant now (Cloud CDN absorbs most reads) but kept
   │     as cheap insurance — Cloud Run cold start can warm faster
   │
   ├─ Layer 4: Hono app router
   │     Matches /api/check-update/* → hotUpdater.handler
   │
   ├─ Layer 5: hot-updater handler (upstream — DO NOT MODIFY)
   │     Matches /v2/fingerprint, /v2/app-version, /version, etc.
   │     Calls business logic
   │
   └─ Layer 6: firebaseDatabase + firebaseFunctionsStorage plugins (tenant-aware)
         currentAppId() reads from ALS (set in Layer 2.5)
         Adds .where("app_id", "==", appId) to every Firestore query
         Verifies returned docs have matching app_id (defense-in-depth)
         For each candidate, storage plugin transforms gs:// URI into
         CDN URL using HOT_UPDATER_CDN_URL=https://ota.tile.dev
```

Six layers, but only Layers 2 (Cache-Control headers), 2.5 (tenant middleware), 3 (in-memory cache), and 6 (plugin guard) are tile-push-specific. The rest is upstream code untouched. The tenant boundary enforcement lives entirely in Layers 2.5 and 6.

**Bundle byte download path** is simpler — no Cloud Run involved:

```
[User device]
   │  HTTPS GET https://ota.tile.dev/t/{appId}/{bundleId}/bundle.zip
   ▼
[LB + Cloud CDN]
   │  URL map: default route → backend-bundles
   │  Cache key: (host, path) — full path matches forever per bundle
   │  ├─ HIT  → serve from edge (~5ms TTFB)
   │  └─ MISS → cache fill from GCS bucket
   ▼
[GCS: tile-push-bundles/t/{appId}/{bundleId}/bundle.zip]
   Cache-Control: public, max-age=31536000, immutable
   (Cached at edge for 1 year, never revalidates)
```

Bundle bytes are content-addressed (UUIDv7 bundle IDs), so the URL never serves different bytes — immutable caching is safe.

## Data model

### Firestore database: `tile-push` (named database, NOT `(default)`)

**Collection: `bundles`**

Each document represents one published bundle. **Every doc has `app_id`** — the plugin layer enforces this on every write, and queries always filter by it.

```ts
// Storage as snake_case fields
{
  id: "01HXYZ...",                      // ULID-style, time-ordered
  app_id: "tk_acme-prod",               // REQUIRED — tenant scope
  platform: "ios" | "android",
  channel: "production" | string,
  fingerprint_hash: string,             // hash of native deps for compatibility check
  target_app_version: "1.2.0" | string,
  enabled: boolean,
  storage_uri: "firebase-storage://tile-push-bundles/t/{appId}/...",
  file_hash: "sha256:...",
  message: "Fix login crash",
  git_commit_hash: string | null,
  should_force_update: boolean,
  rollout_cohort_count: 1000,           // 0-1000 (cohort threshold)
  target_cohorts: [],                   // explicit cohort allowlist
  // ... more fields, see packages/core/src/types.ts Bundle interface
}
```

**Collection: `target_app_versions`**

Maintains a fast-lookup table of supported native app versions per (appId, platform, channel). Used by the app-version update strategy. Doc IDs are `{appId}_{platform}_{channel}_{targetAppVersion}` to prevent cross-tenant collision.

**Collection: `channels`**

Lists which channels exist per tenant. Doc IDs are `{appId}_{channelName}`. Created/updated as side effects of `commitBundle`.

### Composite indexes

Defined in `plugins/firebase/firebase/public/firestore.indexes.json`. Eight indexes cover the query patterns the update-check + admin endpoints need. **Every index begins with `app_id` ASCENDING**, so each tenant's queries scan only their slice.

```
(app_id, channel, enabled, platform, fingerprint_hash, id ASC)        ← fingerprint strategy
(app_id, channel, platform, target_app_version, enabled, id DESC)     ← app-version strategy
(app_id, channel, id DESC)                                             ← admin listing
(app_id, channel, platform, id DESC)                                   ← bundle filtering
(app_id, platform, channel)                                            ← target_app_versions collection
... 4 more variants for different where-clause combinations
```

The `app_id` prefix is what makes the tenant filter free in query cost — Firestore seeks directly to the tenant's segment of the index and scans only there.

## Storage layout

Bundles live in Firebase Storage at `gs://tile-push-bundles/`. **All uploads are tenant-prefixed** by `firebaseStorage.ts` (using `currentAppId(config.appId)` to resolve the prefix).

```
gs://tile-push-bundles/
└── t/                                  ← tenant prefix
    └── {appId}/                        ← e.g. t/tk_acme-prod/
        └── {bundle_id}/
            ├── bundle.zip              # the JS bundle (~5 MB typical)
            ├── manifest.json           # bundle metadata
            └── files/                  # any extracted assets (images, fonts)
```

The `storage_uri` in Firestore points at the bundle.zip with full tenant-prefixed path. Public-read bucket + plain (unsigned) URL via the `cdnUrl` config option mean the function never calls `signBlob` — bundle URLs are returned directly:

```
https://storage.googleapis.com/tile-push-bundles/t/{appId}/{bundleId}/bundle.zip
```

Deleting a tenant becomes a single `gsutil rm -r gs://tile-push-bundles/t/{appId}/`.

**Legacy bundles (uploaded before tenant prefix landed)** live at non-prefixed paths but still resolve via their saved `storage_uri`. New uploads always go to the prefixed path.

## Request flow: update check by fingerprint (v2, multi-tenant)

A typical client request:
```
GET https://ota.tile.dev/api/check-update/v2/t/{appId}/fingerprint/ios/abc123fingerprint/production/00000000-.../00000000-...
                                          │  │  │                  │       │              │           │            │
                                          │  │  │                  │       │              │           │            └─ current bundleId
                                          │  │  │                  │       │              │           └────────────── minBundleId
                                          │  │  │                  │       │              └────────────────────────── channel
                                          │  │  │                  │       └───────────────────────────────────────── fingerprint hash
                                          │  │  │                  └───────────────────────────────────────────────── platform
                                          │  │  └──────────────────────────────────────────────────────────────────── tenant ID (tk_*)
                                          │  └─────────────────────────────────────────────────────────────────────── tenant route segment
                                          └────────────────────────────────────────────────────────────────────────── v2 marker
```

Cohort is NOT in the URL — it's sent as part of the device's local state. The response returns `eligibleNumericCohorts` per candidate, and the client picks. This is what makes the URL CDN-cacheable.

The bundleId and minBundleId path segments are kept in the URL because the server's response varies by these (rollback ordering, force-update enforcement). Cache cardinality is naturally bounded — at steady state most devices in a tenant share the same currentBundleId, so ~3-5 hot cache keys per (tenant, platform, channel, fingerprint).

Server flow (cache MISS path):
1. Firebase Hosting CDN forwards to Cloud Function (cache MISS only — most are HIT)
2. **Tenant middleware** parses `/t/{appId}/`, validates format, strips it, opens `tenantALS.run({ appId }, ...)`
3. In-memory cache check (key `${appId}|${url.pathname}`) — usually MISS on first hit per instance
4. Hono routes `/api/check-update/*` → `hotUpdater.handler` (upstream, untouched)
5. `handleFingerprintUpdateV2` parses URL params, calls `api.getAppUpdateCandidates(...)`
6. `pluginCore` calls `firebaseDatabase.getAppUpdateCandidates` (or `getBundlesByFingerprint` depending on the route)
7. Plugin reads `appId = currentAppId(configAppId)` from ALS
8. Firestore query: `bundles WHERE app_id=? AND platform=? AND channel=? AND enabled=true AND fingerprint_hash=? AND id >= minBundleId`
9. `convertToBundle` verifies returned doc's `app_id` matches — throws on mismatch (defense-in-depth)
10. For each candidate, compute `eligibleNumericCohorts` via `getRolledOutNumericCohorts(bundleId, rolloutCohortCount)`
11. Storage plugin resolves `storage_uri` → public `fileUrl` via `cdnUrl` config (no signBlob)
12. JSON response: `{ candidates: [{ id, status, fileUrl, eligibleNumericCohorts, targetCohorts, ... }] }`
13. Response cached in instance Map (60s TTL); also cached at Hosting CDN edge (60s TTL via Cache-Control header)

Client-side completion:
14. Client receives candidates, calls `getCohort()` to get device's persistent cohort
15. Client `.find()`s the candidate whose `eligibleNumericCohorts` contains the device's cohort
16. If `picked.id !== currentBundleId`, SDK downloads `picked.fileUrl` and installs

## Build pipeline

```
Source (TypeScript across packages and plugins)
   │
   │  $ pnpm nx build @hot-updater/firebase
   ▼
tsdown bundles per tsdown.config.ts in plugins/firebase/
   │   - Reads entry: plugins/firebase/firebase/functions/index.ts
   │   - Walks imports
   │   - For each:
   │     • In `alwaysBundle` list (Hono, @hot-updater/server, @hot-updater/core, etc.) → INLINE
   │     • In `neverBundle` list (firebase-functions, firebase-admin) → leave as require()
   │   - Copies firebase/public/* to dist/firebase/
   ▼
Output:
   plugins/firebase/dist/firebase/
   ├── functions/
   │   └── index.cjs        ← bundled function (~325 KB) — your business logic + framework + Hono
   └── public/
       ├── firebase.json    ← deploy config
       ├── .firebaserc      ← project alias
       ├── firestore.indexes.json
       └── functions/
           └── _package.json   ← template, gets renamed to package.json at deploy time
```

## Deploy pipeline

```
plugins/firebase/dist/firebase/ (build output)
   │
   │  Manual assembly into plugins/firebase/deploy/ (gitignored)
   │  See DEPLOYMENT.md for the exact copy commands
   ▼
plugins/firebase/deploy/
├── firebase.json
├── .firebaserc
├── firestore.indexes.json
└── functions/
    ├── index.cjs
    ├── package.json   (renamed from _package.json — declares 2 runtime deps)
    └── node_modules/  (from `npm install` — gitignored; Firebase CLI needs it locally for introspection)
   │
   │  $ firebase deploy --only functions,firestore:indexes --project apptile-staging-setup
   ▼
Firebase CLI:
   1. Loads/requires index.cjs to discover exports
      → finds tile.push function with __endpoint metadata
   2. Tars functions/ (excludes node_modules per firebase.json ignore field)
   3. Uploads tarball to GCS
   4. Triggers Cloud Build:
      - npm install (fetches firebase-functions, firebase-admin from npm)
      - Builds Docker image
      - Pushes to Artifact Registry
   5. Deploys to Cloud Run (Cloud Functions Gen 2 = Cloud Run with extra abstractions)
   6. Deploys firestore.indexes.json to the `tile-push` database (specified in firebase.json)
   │
   ▼
Live function at https://tile-push-io7lmh2oqa-uc.a.run.app
(Also accessible via https://us-central1-apptile-staging-setup.cloudfunctions.net/tile-push)
```

## Cache-Control + invalidation

| URL pattern | Cache-Control header | Set by | TTL at edge |
|---|---|---|---|
| `/api/check-update/*` | `public, max-age=60, s-maxage=2592000` | Cloud Run response (in [`index.ts`](../plugins/firebase/firebase/functions/index.ts)) | 30 days, invalidated per tenant on deploy |
| `/api/cli/*` | `private, no-store` + `Vary: Authorization` | Cloud Run response | NEVER cached |
| `/t/{appId}/{bundleId}/**` (bundle bytes) | `public, max-age=31536000, immutable` | GCS object metadata (set at upload via signed PUT URL) | 1 year, never revalidates |

**Invalidation flow:** when a deploy completes, the CLI's POST to `/api/cli/t/{appId}/bundles` triggers (after the Firestore commit):

```ts
POST https://compute.googleapis.com/.../urlMaps/tile-push-lb/invalidateCache
{ "path": "/api/check-update/v2/t/{appId}/*" }
```

Cloud CDN flushes every cache entry under that prefix across the global edge fleet (<60s typical). Devices on their next check-update request get the new bundle list.

Bundle bytes never need invalidation — content-addressed paths mean each URL serves the same bytes forever, so they cache permanently.

## IAM model

| Identity | Permissions | Purpose |
|---|---|---|
| `tile-push` Cloud Run service's runtime SA (`1097788179850-compute@developer.gserviceaccount.com`) | Project Editor (default), Cloud Run Invoker | Reads/writes Firestore (`tile-push` DB), reads/writes Storage (`tile-push-bundles`), calls Cloud CDN `urlMaps.invalidateCache` API on each deploy |
| `allUsers` (public) | `run.invoker` on the `tile-push` Cloud Run service | Lets the RN client hit the function without auth |
| `allUsers` (public) | `storage.objectViewer` on `gs://tile-push-bundles` | Allows direct bundle downloads via CDN backend bucket without signed URLs |
| Firebase Hosting service | (managed by Google) | Still routes `apptile-staging-setup.web.app/api/**` to Cloud Run as a fallback path |
| Developer (you) | Project IAM permissions | Deploy via firebase CLI, manage LB via gcloud |

**Note on public access:**
- The function's `allUsers → run.invoker` makes update-check publicly callable. Tenant boundary is enforced inside the function (Layer 2.5 middleware + Layer 6 plugin).
- The bucket's public-read removes signBlob latency. Bundle integrity is verified via the `file_hash` field in the response; URL secrecy is NOT a security mechanism.
- Future: per-tenant API key auth for write endpoints (deploys, bundle management). Read endpoints (check-update) stay public.

## Cost model

Numbers at 1M DAU across many tenants assuming v2 CDN-cacheable URLs (current architecture):

| Item | Volume/month | Cost |
|---|---|---|
| Cloud Function invocations (1% MISS rate at edge) | ~1.2M | ~$1–2 |
| Firestore reads (with in-instance Map cache halving misses) | ~3M | ~$1–2 |
| Firestore writes (deploys) | ~30k | <$1 |
| Firestore storage | 2–5 GB | $1 |
| Firebase Storage at rest | ~5 TB | $100 |
| Firebase Storage egress (CDN absorbs ~99%) | ~210 GB cache fill + minor | ~$30 |
| Firebase Hosting bandwidth (~600 GB shipped from edge) | ~600 GB | ~$90 |
| Total at 1M DAU (current architecture) | | **~$225/mo** |

Optimization phases left:
- Migrate bundle storage to Cloudflare R2 (zero egress): drops storage egress + Hosting bandwidth from ~$120 to ~$0. **Total goes to ~$135/mo.**
- Cloudflare Workers fronting (replaces Hosting): trades $90 Hosting bandwidth for ~$30 Workers invocations. **Total goes to ~$165/mo.** Probably skip unless egress-pricing-economics requires it.

See `LATENCY_ANALYSIS.md` for cost projections at higher scales (10M, 100M, 1B DAU).

## Why named Firestore database (`tile-push` not `(default)`)

- The shared GCP project (`apptile-staging-setup`) already has Firestore databases for other apps (`apptile`, `devappconfigresolver-db`)
- Putting OTA data in `(default)` would mix with whatever someone might use the default DB for in the future
- Named databases are isolated — separate IAM granularity possible, separate free tier, easy to delete/restore
- Trade-off: Firebase Admin SDK requires the modular `getFirestore(app, "tile-push")` API instead of the default `admin.firestore(app)`. That's a one-line code change in `firebaseDatabase.ts`.

## What's NOT in this architecture yet (roadmap)

1. ~~**Multi-tenancy**~~ — ✅ DONE. `appId` enforced on every query, URL, storage upload, cache key. See [Hard rules in CLAUDE.md](./CLAUDE.md).
2. ~~**Cloud CDN**~~ — ✅ DONE (2026-05-25). Cloud CDN behind LB fronts `ota.tile.dev`. 30d edge TTL, per-tenant invalidation on deploy. See [`GCP_INFRASTRUCTURE.md`](./GCP_INFRASTRUCTURE.md).
3. ~~**Custom domain**~~ — ✅ DONE. `https://ota.tile.dev` is the production endpoint, DNS on AWS Route 53, SSL via Google-managed cert.
4. ~~**Cohort URL collapse optimization**~~ — ✅ DONE. v2 endpoint moves cohort picking to client; URLs are now CDN-cacheable.
5. ~~**Customer-facing SDK + CLI**~~ — ✅ DONE. `@tile-push/react-native` and `@tile-push/cli` ship; SDK default baseURL is `https://ota.tile.dev`.
6. **Per-tenant admin console** — pending. Fork of `@hot-updater/console`, rebrand, wire to `/api/cli/*`. Repo: `tile-web`. See [`ROADMAP.md`](./ROADMAP.md).
7. **npm publish** — pending. `@tile-push/cli` + `@tile-push/react-native` are workspace-only today.
8. **Patch generation** — pending. Server should generate per-asset diffs so devices fetch only changed bytes.
9. **Per-project credentials** — pending. `~/.tile-push/credentials.json` currently single-tenant; needs map keyed by `appId` for multi-project laptop workflows.
10. **Cloudflare R2 + Workers + D1 migration** — post-demo. ~98% cost reduction at hyper-viral scale via free egress. See [`ROADMAP.md`](./ROADMAP.md).
11. **iOS bare RN integration guide** — post-demo. Mirror of the Android guide in [`packages/tile-push-cli/INTEGRATION_BARE_RN_ANDROID.md`](../packages/tile-push-cli/INTEGRATION_BARE_RN_ANDROID.md).
