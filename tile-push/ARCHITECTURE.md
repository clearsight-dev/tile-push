# tile-push Architecture

This document describes the current multi-tenant MVP architecture and how it works end-to-end. Read this when you need to understand what runs where, why it's structured the way it is, or how to change it.

## High-level diagram

```
                                        ┌─ DEPLOY PATH ──────────────────┐
                                        │ Developer machine              │
                                        │  $ npx hot-updater deploy      │
                                        │  ↳ uses appId from config      │
                                        │  ↳ uploads to t/{appId}/...    │
                                        │  ↳ writes Firestore doc w/     │
                                        │    app_id = tk_acme            │
                                        └──────────────┬─────────────────┘
                                                       │
                                                       ▼
                                              gs://tile-push-bundles/
                                              t/{appId}/{bundleId}/
                                                bundle.zip + assets
                                                       │
                                                       │
┌──────────────────┐                                   │
│ React Native app │                                   │
│  HotUpdater.wrap │                                   │
│  ({appId})       │     READ PATH                     │
│                  │                                   │
│ GET /api/check-  │ ─── HTTPS ───▶ ┌──────────────────▼────────────────────┐
│ update/v2/t/     │                │ Firebase Hosting CDN                  │
│ {appId}/...      │ ◀── JSON ───── │ (Google edge POPs)                    │
└────────┬─────────┘                │                                       │
         │                          │ ✓ cache HIT (~99%): serves from POP   │
         │                          │ ✗ cache MISS: forwards to origin      │
         │ download                 └──────────┬────────────────────────────┘
         │ from public URL                     │ (cache MISS only)
         │                                     ▼
         │                          ┌────────────────────────────────────┐
         │                          │ Cloud Function tile-push           │
         │                          │ us-central1 (Gen 2 / Cloud Run)    │
         │                          │                                    │
         │                          │ 1. Tenant middleware:              │
         │                          │    extract /t/{appId}/, validate,  │
         │                          │    strip from path, set ALS ctx    │
         │                          │ 2. In-memory cache check           │
         │                          │ 3. Hono → upstream handler         │
         │                          │ 4. firebaseDatabase plugin reads   │
         │                          │    currentAppId() from ALS         │
         │                          │ 5. Firestore query with            │
         │                          │    .where("app_id", "==", appId)   │
         │                          └──────────┬─────────────────────────┘
         │                                     │
         │                                     ▼
         │                          ┌────────────────────────────────────┐
         │                          │ Firestore (named DB: tile-push)    │
         │                          │  collection: bundles               │
         │                          │  every doc has app_id field        │
         │                          │  every composite index has app_id  │
         │                          │  as first column                   │
         │                          └────────────────────────────────────┘
         │
         ▼
   gs://tile-push-bundles/t/{appId}/{bundleId}/bundle.zip
   (public-read, served directly via Google's edge — zero signing latency)
```

## Tech stack

| Layer | Tech | Why this choice |
|---|---|---|
| CDN / edge cache | Firebase Hosting (Google's global edge network) | Free for static + function rewrites, same edge POPs as Cloud CDN, no LB cost, auto SSL |
| Function runtime | Firebase Cloud Functions Gen 2 (which is Cloud Run under the hood) | Auto-scales 0→N, native Firebase integration, GCP credits apply |
| Web framework | Hono (inside the function) + Express (provided by Google's Functions Framework) | Hono is runtime-portable; Express is what Cloud Functions speaks. A small adapter bridges them. |
| Tenant context propagation | Node.js `AsyncLocalStorage` | Per-request store visible to deeply nested async code without parameter threading. Upstream code stays untouched. |
| In-instance cache | Module-level `Map<string, CacheEntry>` with TTL | Zero infra; works across Cloud Run requests on the same warm instance. Cache key is tenant-scoped. |
| Database | Firestore Native mode, named database `tile-push` | NoSQL doc store, auto-scales to billions of docs, GCP credits cover it. Note: Admin SDK bypasses Security Rules, so tenant isolation is enforced at the plugin layer. |
| Bundle storage | Firebase Cloud Storage (`tile-push-bundles` bucket, public-read, tenant-prefixed) | Same project, lowest config friction. Public-read removes signBlob bottleneck. Tenant prefix lets us cleanly delete a tenant's data with a single recursive `rm`. Will migrate to Cloudflare R2 later. |
| Build | `tsdown` (TypeScript bundler using rolldown) | Used by the upstream hot-updater repo; bundles everything except `firebase-functions` + `firebase-admin` |
| Deploy CLI | `firebase` (firebase-tools) | Standard Firebase deploy tool — handles function provisioning, IAM, indexes, hosting |

## What's actually running

When a request hits `https://apptile-staging-setup.web.app/api/check-update/v2/t/{appId}/fingerprint/...`, this is the call chain:

```
[User device]
   │  HTTPS request
   ▼
[Firebase Hosting CDN — Google's edge network]
   │  TLS termination at nearest POP (e.g. MAA for India)
   │  Check Cache Rule for /api/check-update/v2/**:
   │   ├─ HIT  → serve from POP shard (~5ms server time, ~100ms total client)
   │   └─ MISS → forward to origin                                    ─┐
                                                                       │
[Google's Cloud Run frontend] ◀──────────────────────────────────────── ┘
   │  TLS termination at us-central1
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
   │
   ├─ Layer 2.5: TENANT MIDDLEWARE (in our code) — multi-tenant gate
   │     Match URL: /api/check-update/v2/t/{appId}/(.+)
   │     Validate appId format (isValidAppId)
   │     Strip /t/{appId} from URL
   │     tenantALS.run({ appId }, async () => { ... rest ... })
   │
   ├─ Layer 3: In-memory cache check (in our code)
   │     Cache key: `${appId}|${url.pathname}`
   │     HIT  → return cached response (~5ms server time)
   │     MISS → call app.fetch(request)
   │
   ├─ Layer 4: Hono app router
   │     Matches /api/check-update/* → hotUpdater.handler
   │
   ├─ Layer 5: hot-updater handler (upstream — DO NOT MODIFY)
   │     Matches /v2/fingerprint, /v2/app-version, /version, etc.
   │     Calls business logic
   │
   └─ Layer 6: firebaseDatabase plugin (tenant-aware)
         Calls currentAppId() — reads from ALS (set in Layer 2.5)
         Adds .where("app_id", "==", appId) to every Firestore query
         Verifies returned docs have matching app_id (defense-in-depth)
         Generates plain (unsigned) storage URLs from doc's storage_uri
```

Six layers, but only Layers 2.5, 3, and 6 are tile-push-specific — the rest is upstream code untouched. The tenant boundary enforcement lives entirely in Layers 2.5 (middleware) and 6 (plugin guard); upstream Hono and hot-updater handler are completely tenant-agnostic.

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

A typical client request (CDN-cacheable, no per-device URL variables):
```
GET /api/check-update/v2/t/{appId}/fingerprint/ios/abc123fingerprint/production/00000000-.../00000000-...
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

## IAM model

| Identity | Permissions | Purpose |
|---|---|---|
| `tile-push` Cloud Run service's runtime SA | Project Editor (default) | Reads/writes Firestore (`tile-push` DB), reads/writes Storage (`tile-push-bundles`) |
| `allUsers` (public) | `run.invoker` on the `tile-push` Cloud Run service | Lets the RN client hit the function without auth |
| `allUsers` (public) | `storage.objectViewer` on `gs://tile-push-bundles` | Allows direct bundle downloads without signed URLs (skips signBlob bottleneck) |
| Firebase Hosting service | (managed by Google) | Forwards requests to the Cloud Function via firebase.json rewrites |
| Developer (you) | Project IAM permissions | Deploy via firebase CLI |

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

1. **Multi-tenancy** — `appId` field exists but no queries filter by it. Tenant_id should come from URL path or API key.
2. **Cloud CDN** — would absorb ~85%+ of update-check traffic, slashing function invocations
3. **Cloudflare R2 for bundle storage** — would eliminate the egress bill
4. **Cohort URL collapse optimization** — when no rollout is active, drop cohort from URLs; collapses 1000 cache entries into 1
5. **Custom domain** (`ota.tile.dev` or similar) — requires Cloud CDN + LB setup
6. **Per-tenant admin console** — fork of `@hot-updater/console`
7. **Customer-facing SDK + CLI** — forks of `@hot-updater/react-native` and `hot-updater` CLI
