# tile-push Architecture

This document describes the current single-tenant MVP architecture and how it works end-to-end. Read this when you need to understand what runs where, why it's structured the way it is, or how to change it.

## High-level diagram

```
┌──────────────────┐                                       ┌──────────────────────────┐
│ React Native app │                                       │  GCP: apptile-staging-   │
│  (customer's)    │                                       │       setup project      │
│                  │                                       │                          │
│  - calls         │── HTTPS GET /api/check-update/... ──▶ │  Cloud Function          │
│    /fingerprint  │   { JSON request }                    │  (Gen 2 / Cloud Run)     │
│    /app-version  │ ◀── { fileUrl, status, hash, ... } ── │   tile-push              │
│                  │                                       │   us-central1            │
│  - if AVAILABLE  │                                       │                          │
│    downloads     │                                       │  ┌─ uses ───────────┐    │
│    fileUrl       │                                       │  ▼                  │    │
└──────────────────┘                                       │  Firestore          │    │
        │                                                  │  database:tile-push │    │
        │                                                  │  collection:bundles │    │
        │                                                  │                     │    │
        │                                                  │  ┌─ generates       │    │
        │                                                  │  │  download URL    │    │
        │                                                  │  ▼                  │    │
        │                                                  │  Firebase Storage   │    │
        │                                                  │  bucket:            │    │
        │                                                  │   tile-push-bundles │    │
        │                                                  └──────────┬──────────┘    │
        │                                                             │               │
        │  GET https://...firebasestorage.googleapis.com/...zip       │               │
        └─────────────────────────────────────────────────────────────┘               │
                                                                                      │
                                                          ┌───────────────────────────┘
```

## Tech stack

| Layer | Tech | Why this choice |
|---|---|---|
| Function runtime | Firebase Cloud Functions Gen 2 (which is Cloud Run under the hood) | Auto-scales 0→N, native Firebase integration, GCP credits apply |
| Web framework | Hono (inside the function) + Express (provided by Google's Functions Framework) | Hono is runtime-portable; Express is what Cloud Functions speaks. A small adapter bridges them. |
| Database | Firestore Native mode, named database `tile-push` | NoSQL doc store, auto-scales to billions of docs, multi-region option available, GCP credits cover it |
| Bundle storage | Firebase Cloud Storage (`tile-push-bundles` bucket) | Same project, default IAM, lowest config friction for v1. Will migrate to Cloudflare R2 later. |
| Build | `tsdown` (TypeScript bundler using rolldown) | Used by the upstream hot-updater repo; bundles everything except `firebase-functions` + `firebase-admin` |
| Deploy CLI | `firebase` (firebase-tools) | Standard Firebase deploy tool — handles function provisioning, IAM, indexes |

## What's actually running

When a request hits `https://tile-push-io7lmh2oqa-uc.a.run.app/api/check-update/version`, this is the call chain:

```
[User device]
   │  HTTPS request
   ▼
[Google's Cloud Run frontend]
   │  TLS termination, routing
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
   │     Calls app.fetch(webRequest)
   │
   ├─ Layer 3: Hono app router
   │     Matches /api/check-update/* → hotUpdater.handler
   │
   ├─ Layer 4: hot-updater handler (the framework's internal router)
   │     Matches /version, /fingerprint, /app-version, /api/bundles, etc.
   │     Calls business logic
   │
   └─ Layer 5: firebaseDatabase plugin
         Issues Firestore queries
         Generates signed/public storage URLs
```

Three concentric routers (Functions Framework → Hono → hot-updater handler) all live in the same container, all run in the same Node process. The layering is what makes the framework portable — if we migrated to Cloudflare Workers, only the outermost layer (Functions Framework / Express) would change.

## Data model

### Firestore database: `tile-push` (named database, NOT `(default)`)

**Collection: `bundles`**

Each document represents one published bundle.

```ts
// Storage as snake_case fields
{
  id: "01HXYZ...",                      // ULID-style, time-ordered
  platform: "ios" | "android",
  channel: "production" | string,
  fingerprint_hash: string,             // hash of native deps for compatibility check
  target_app_version: "1.2.0" | string,
  enabled: boolean,
  storage_uri: "firebase-storage://tile-push-bundles/...",
  file_hash: "sha256:...",
  message: "Fix login crash",
  git_commit_hash: string | null,
  should_force_update: boolean,
  rollout_count: 1000,                  // 0-1000 (cohort threshold)
  target_cohorts: [],                   // explicit cohort allowlist
  app_id: null                          // RESERVED for multi-tenancy (no queries use it yet)
  // ... more fields, see packages/core/src/types.ts Bundle interface
}
```

**Collection: `target_app_versions`**

Maintains a fast-lookup table of supported native app versions per (platform, channel). Used by the app-version update strategy.

### Composite indexes

Defined in `plugins/firebase/firebase/public/firestore.indexes.json`. Seven indexes cover the query patterns the update-check + admin endpoints need. Each is on the `bundles` collection. Most-used:

```
(platform, channel, fingerprint_hash, enabled, id DESC)   ← fingerprint strategy
(platform, channel, target_app_version, enabled, id DESC) ← app-version strategy
(channel, id DESC)                                         ← admin listing
```

**For multi-tenancy (planned):** every index needs `app_id` prepended as the first field, e.g. `(app_id, platform, channel, fingerprint_hash, enabled, id DESC)`.

## Storage layout

Bundles live in Firebase Storage at `gs://tile-push-bundles/`. The CLI's deploy command creates a structure like:

```
gs://tile-push-bundles/
└── <bundle_id>/
    ├── bundle.zip                      # the JS bundle (~5 MB typical)
    ├── manifest.json                   # bundle metadata
    └── assets/                         # any extracted assets (images, fonts)
```

The `storage_uri` in Firestore points at the bundle.zip. The server generates a download URL (signed or public depending on bucket access mode) when the RN client requests an update.

## Request flow: update check by fingerprint

A typical client request:
```
GET /api/check-update/fingerprint/ios/abc123fingerprint/production/00000000-.../00000000-.../427
                                  │       │              │           │            │       │
                                  │       │              │           │            │       └─ cohort (1-1000)
                                  │       │              │           │            └───────── current bundleId (device's)
                                  │       │              │           └────────────────────── minBundleId (floor for channel switch)
                                  │       │              └────────────────────────────────── channel
                                  │       └───────────────────────────────────────────────── fingerprint hash
                                  └───────────────────────────────────────────────────────── platform
```

Server flow:
1. Hono routes `/api/check-update/*` to `hotUpdater.handler`
2. `handleFingerprintUpdateWithCohort` parses URL params
3. Calls `api.getUpdateInfo({ platform, fingerprintHash, channel, minBundleId, bundleId }, cohort)`
4. Wrapped via `pluginCore` → calls `firebaseDatabase.getUpdateInfo`
5. `getUpdateInfo` is built from three sub-methods (see `createDatabasePluginGetUpdateInfo`):
   - For fingerprint strategy: calls `getBundlesByFingerprint`
   - That runs a Firestore query: `bundles WHERE platform=? AND channel=? AND enabled=true AND fingerprint_hash=? AND id >= minBundleId`
6. Returns candidate bundles
7. `isCohortEligibleForUpdate` filters by cohort (affine permutation, see `packages/core/src/rollout.ts`)
8. Storage plugin resolves `storage_uri` → public/signed `fileUrl`
9. JSON response: `{ status: "AVAILABLE" | "UP_TO_DATE" | "ROLLBACK" | null, id, fileUrl, fileHash, ... }`

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
| `tile-push` Cloud Run service's runtime SA | Project Editor (default) | Reads/writes Firestore, reads/writes Storage |
| `allUsers` (public) | `run.invoker` on the `tile-push` service | Lets the RN client hit the function without auth (anyone can call) |
| Developer (you) | Project IAM permissions | Deploy via firebase CLI |

**Note on public access:** The function's `allUsers → run.invoker` binding is what makes update-check public. When multi-tenancy lands, we'll add API key auth in middleware, but the function itself stays public to the world (with the gate in code).

## Cost model (current, no CDN, no multi-tenancy yet)

At expected scale of 1M DAU across many tenants (when multi-tenancy ships), brute-force pricing:

| Item | Volume/month | Cost |
|---|---|---|
| Cloud Function invocations | ~120M (no CDN) → drops to ~18M with CDN | ~$25–50 |
| Firestore reads | 240M (no CDN) → 36M with CDN | ~$22–150 |
| Firestore writes (deploys) | ~30k | <$1 |
| Firestore storage | 2-5 GB | $1 |
| Firebase Storage at rest | 5 TB | $100 |
| Firebase Storage egress (no CDN) | 21 TB | ~$1,500 ← biggest line item |
| Total (no CDN, no R2) | | ~$1,650/mo at 1M DAU |
| Total with CDN + R2 migration | | ~$200/mo at 1M DAU |

The bundle egress is what dominates. Migrating to Cloudflare R2 ($0 egress) cuts the bill ~88%. See roadmap.

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
