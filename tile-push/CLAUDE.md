# tile-push (CLAUDE.md)

This file is the agent-readable summary of this fork. **Read this first** when working on tile-push tasks. The rules in [Hard rules for any code change](#hard-rules-for-any-code-change) are non-negotiable.

## What this is

`tile-push` is a fork of [hot-updater](https://github.com/gronxb/hot-updater) (MIT) being shaped into a **multi-tenant OTA-as-a-Service** product. The fork lives at https://github.com/clearsight-dev/tile-push.

Current state: **multi-tenant MVP deployed with CDN edge caching**. Every check-update request is tenant-scoped via `appId` and served sub-150ms from Chennai POPs.

## Current production setup

| | |
|---|---|
| GCP project | `apptile-staging-setup` (project number `1097788179850`) |
| Region | `us-central1` |
| Cloud Function name | `tile-push` (Gen 2, runs on Cloud Run) |
| Function URL (direct origin) | `https://tile-push-io7lmh2oqa-uc.a.run.app` |
| **Primary URL (Cloud CDN + LB)** | `https://ota.tile.dev` ← SDK baseURL, customer-facing |
| Fallback URL (Firebase Hosting) | `https://apptile-staging-setup.web.app` (kept alive for old SDK builds) |
| Cloud LB resources | static IP `tile-push-lb-ip`, cert `tile-push-cert-v2`, URL map `tile-push-lb`, NEG `tile-push-neg`, backends `backend-checkupdate` / `backend-admin` / `backend-bundles` — see [`GCP_INFRASTRUCTURE.md`](./GCP_INFRASTRUCTURE.md) |
| DNS | `ota.tile.dev A 8.233.151.195` on AWS Route 53 (tile.dev hosted zone) |
| Firestore database | `tile-push` (named DB, not `(default)`) |
| Storage bucket | `tile-push-bundles` (in same project, us-central1; public-read, immutable Cache-Control on every object) |
| Deploys via | `firebase deploy --only functions,hosting --project=apptile-staging-setup` from `plugins/firebase/deploy/` |
| Cache invalidation | Cloud Run calls `urlMaps.invalidateCache` after every successful deploy — pattern `/api/check-update/v2/t/{appId}/*` |
| Test tenant in Firestore | `tk_tilepacket-test` (3 backfilled bundles), `tk_apptile-seed`, `tk_tilepacket` |

## Hard rules for any code change

These rules exist because past incidents made them necessary. **Violating them silently is a security or performance bug, not a stylistic issue.**

**Caveat — surface alternatives, don't pretend rules don't exist.** If a task has a cleaner or more interesting solution that *doesn't* follow one of these rules (e.g. a header-based tenant ID for an admin endpoint that's truly never CDN-cached, a temporary tenant-agnostic read for an internal migration script, a path that touches upstream code in exchange for a much smaller diff), **bring it up with the user.** Explain the trade-off — what the rule was protecting against, why this case is different, what the failure mode would look like if you're wrong — and let them confirm the choice. Quiet violations are a bug. Discussed, justified, and approved exceptions are fine. The rules are the *default*; the user's the deciding voice.

### Rule 1 — Every database query MUST be tenant-scoped via `appId`

`firebaseDatabase.ts` is the only place that touches Firestore. Every method MUST:
1. Call `currentAppId(config.appId)` from `tenantContext.ts` at entry (it throws if no tenant context)
2. Apply `.where("app_id", "==", appId)` as the first filter on every Firestore query
3. Inject `app_id: appId` into every document write

If you add a new query method, copy the pattern of `getBundlesByFingerprint`. The tenant filter is not optional — Firestore has no row-level security with the Admin SDK, so the plugin layer IS the only enforcement.

Composite indexes in `firestore.indexes.json` MUST list `app_id` as the first field (ASCENDING). Without it, the tenant filter forces a collection scan.

### Rule 2 — Every new HTTP route MUST be tenant-routed via `/t/{appId}/`

URLs that hit the database must follow the pattern:
```
/api/check-update/v2/t/{appId}/<resource>/<params...>
```

The middleware in `plugins/firebase/firebase/functions/index.ts` extracts `{appId}`, validates format (`tk_[a-z0-9-]{3,40}`), stores it in `tenantALS`, and strips it before forwarding. **Do not bypass the middleware**: any new route that hits the database must go through `tenantALS.run({ appId }, ...)`.

If a route is genuinely tenant-agnostic (e.g. `/ping`, `/api/check-update/version`), it can skip the tenant middleware, but it MUST NOT touch the database. If it does, `currentAppId()` will throw and you'll get a 500 — that's the system telling you you have a bug.

### Rule 3 — Every storage upload MUST be prefixed with `t/{appId}/`

`firebaseStorage.ts` upload path prefixes object keys via `resolveStorageKeyBuilder()`. **Do not write objects with non-tenanted keys.** This keeps bundles physically segregated in the bucket and lets a future "delete tenant" job rm a prefix.

`getDownloadUrl` doesn't need a tenant filter because the bundle's `storage_uri` (which was written under the tenant prefix at upload time) is the only thing that points at the file. But the public-bucket model means any URL is technically reachable; **integrity is the file hash, not URL secrecy**.

### Rule 4 — Cache keys MUST include tenant scope

The in-memory cache in `firebase/functions/index.ts` already does this:
```ts
const key = `${tenantScope ?? "_"}|${url.pathname}`;
```

If you add ANY caching layer (in-memory, CDN, Redis, browser), tenant scope MUST be part of the cache key. **Two tenants serving the same cached response is a data-leak class bug.**

For CDN: tenant lives in URL path (`/t/{appId}/...`), so cache key is naturally scoped — no extra config needed for Firebase Hosting / Cloudflare. Don't add header-based tenant routing without explicitly opting that header into the cache key.

### Rule 5 — Every new URL MUST be CDN-cacheable

A URL is CDN-cacheable iff response varies ONLY by URL path (no per-device headers, no cookies, no query params that vary per device). The big anti-pattern that almost broke us:

- v1: `.../fingerprint/{platform}/{fp}/{channel}/{minBundle}/{currentBundle}/{cohort}` — cohort is per-device → URL space exploded by 1000× → CDN useless
- v2: `.../fingerprint/{platform}/{fp}/{channel}/{minBundle}/{currentBundle}` (cohort returned in body, client picks) → URL space ~1 per app per fingerprint → CDN works

When adding a new endpoint:
- If the response varies per device (cohort, user ID, etc.), **return the data the client needs to filter locally** instead of putting the variable in the URL.
- Set explicit `Cache-Control` headers (or rely on Firebase Hosting `headers` config in `firebase.json`) — Cloud Run doesn't emit cacheable headers by default.

### Rule 6 — Don't touch upstream `packages/server/`, `packages/core/`, `packages/react-native/`

The fork's entire customization lives in `plugins/firebase/`. The upstream packages are left alone so we can pull in upstream updates indefinitely. If a change "requires" touching upstream, stop and find a way to do it in the plugin layer (this is what AsyncLocalStorage solved for multi-tenancy — no upstream changes needed).

The one exception: `packages/core/src/types.ts` may have benign additive fields (e.g. optional `appId?: string`) needed for the SnakeCase derivation to work. Adding fields is fine; renaming or changing types is not.

### Rule 7 — Validate `appId` format at the edge

Format: `tk_[a-z0-9][a-z0-9-]{2,38}[a-z0-9]` (see `isValidAppId` in `tenantContext.ts`). Reject malformed appIds with a 400 BEFORE running any business logic. This prevents:
- URL injection (e.g. `tk_../bundles/leak`)
- Database key collisions if some hypothetical other system also uses these IDs
- Operational confusion (slugs with capitals are case-sensitive in URLs but case-insensitive in many tools)

### Rule 8 — Type-tightened internal types

`firebaseDatabase.ts` uses these internal types:
```ts
type TenantBundle = Bundle & { appId: string };
type TenantSnakeCaseBundle = SnakeCaseBundle & { app_id: string };
type TenantQueryWhere = DatabaseBundleQueryWhere & { appId: string };
```

The plugin's internal helpers (`applyFirestoreQueryableFilters`, `convertToBundle`, etc.) use the strict types. **If you add a helper, parameter it with the tenant-required types** so TypeScript catches missing `appId` at compile time. This is the type-level half of the rule-1 enforcement.

## Diff from upstream (what we changed)

Eight focused changes. See `ARCHITECTURE.md` for full details.

1. **[packages/core/src/types.ts](../packages/core/src/types.ts)** — added `appId?: string` to `Bundle` interface (optional; tile-push plugin enforces it as required internally)
2. **[plugins/firebase/src/firebaseDatabase.ts](../plugins/firebase/src/firebaseDatabase.ts)** — switched to `getFirestore(app, "tile-push")` for named-DB queries; added centralized `currentAppId()` guard and tenant-scoped queries throughout
3. **[plugins/firebase/src/firebaseStorage.ts](../plugins/firebase/src/firebaseStorage.ts)** — added `cdnUrl` option (skips signBlob) and `appId` config (prefixes storage keys with `t/{appId}/`)
4. **[plugins/firebase/src/tenantContext.ts](../plugins/firebase/src/tenantContext.ts)** — *new file*. AsyncLocalStorage-based per-request tenant context; `currentAppId()` helper; `isValidAppId()` format guard
5. **[plugins/firebase/firebase/functions/index.ts](../plugins/firebase/firebase/functions/index.ts)** — tenant middleware (extract `/t/{appId}/`, validate, strip, run in ALS); in-memory cache with tenant-scoped key; v2 endpoint support
6. **[plugins/firebase/firebase/public/firebase.json](../plugins/firebase/firebase/public/firebase.json)** — Firebase Hosting rewrites + cache headers (60s TTL on `/api/check-update/v2/**`)
7. **[plugins/firebase/firebase/public/firestore.indexes.json](../plugins/firebase/firebase/public/firestore.indexes.json)** — every composite index now has `app_id` as first field
8. **[plugins/firebase/tsdown.config.ts](../plugins/firebase/tsdown.config.ts)** — added `hono` and `@hot-updater/server/runtime` to `alwaysBundle`

## Where things live

```
plugins/firebase/
├── src/
│   ├── firebaseDatabase.ts          # all Firestore access, tenant-aware
│   ├── firebaseStorage.ts           # GCS uploads + tenant prefixes
│   ├── firebaseFunctionsStorage.ts  # runtime variant (used by Cloud Function)
│   └── tenantContext.ts             # AsyncLocalStorage + currentAppId()
├── firebase/
│   ├── functions/index.ts           # the Cloud Function entry (tenant middleware lives here)
│   └── public/                      # files copied into the deploy bundle
│       ├── firebase.json            # rewrites + cache-control headers
│       ├── .firebaserc              # project alias
│       ├── firestore.indexes.json   # composite indexes (app_id first)
│       ├── hosting/index.html       # Hosting requires public/ — placeholder
│       └── functions/_package.json  # runtime deps template
├── tsdown.config.ts
├── dist/                            # build output (not committed)
└── deploy/                          # assembled deploy directory (gitignored)
```

## When to do what

| Goal | Approach |
|---|---|
| Add a new field to bundles | Add to `Bundle` interface in `packages/core/src/types.ts`; `SnakeCaseBundle` auto-derives. Then add the field to `convertToBundle` + `commitBundle` in `firebaseDatabase.ts`. Inject value from request/context (must NOT trust client for security-sensitive fields). |
| Change a Firestore query | Edit `plugins/firebase/src/firebaseDatabase.ts`. ALWAYS keep the `.where("app_id", "==", appId)` filter. Update `firestore.indexes.json` if you add a new composite-filter combination. |
| Add a new HTTP route | Add to `plugins/firebase/firebase/functions/index.ts` (firebase-specific) OR (rarely) `packages/server/src/handler.ts` (universal). Multi-tenant routes MUST go under `/v2/t/{appId}/`. Pure-tenant-agnostic routes (health, version) go elsewhere. |
| Change cohort math | Edit `packages/core/src/rollout.ts`. Both server and client call `isCohortEligibleForUpdate(id, cohort, rolloutCohortCount, targetCohorts)` to compute eligibility independently — algorithm must stay deterministic per-bundleId so they agree. (The redundant `eligibleNumericCohorts` array was stripped from responses on 2026-05-26; see [`LATENCY_ANALYSIS.md`](./LATENCY_ANALYSIS.md).) |
| Add a new tenant | (Future) admin endpoint to create one. For now, just start using a new `tk_*` appId — the test path doesn't require pre-registration, queries just return empty for unknown tenants. |
| Bundle build | `pnpm nx build @hot-updater/firebase` from repo root. Sync `dist/` to `tilepacket/node_modules/@hot-updater/firebase/dist/` for CLI testing. |
| Deploy | See `DEPLOYMENT.md`. Quick form: assemble `deploy/`, `firebase deploy --only functions:tile-push,firestore:indexes,hosting --project apptile-staging-setup`. |
| Investigate latency | See `LATENCY_ANALYSIS.md`. Server-side latency is in Cloud Run logs (`httpRequest.latency` field); CDN status in `cf-cache-status` / `x-cache` response headers. |

## What NOT to do

- ❌ Don't query Firestore without `.where("app_id", "==", appId)` — Rule 1.
- ❌ Don't add a new endpoint without `/t/{appId}/` in the path unless it's truly tenant-agnostic (and doesn't touch the database) — Rule 2.
- ❌ Don't upload to GCS without the `t/{appId}/` prefix — Rule 3.
- ❌ Don't cache anything without tenant in the cache key — Rule 4.
- ❌ Don't put per-device values in URL paths (cohort, user ID, anything that varies per request) — kills CDN — Rule 5.
- ❌ Don't modify upstream packages — Rule 6.
- ❌ Don't accept arbitrary appId strings — Rule 7. Use `isValidAppId()`.
- ❌ Don't try to use the `(default)` Firestore database — `tile-push` is the named DB.
- ❌ Don't rename the function back to `hot-updater` — clients depend on `tile-push`.
- ❌ Don't modify other plugins (aws, cloudflare, supabase, postgres, etc.) — only firebase is in scope.

## Quick verification commands

```bash
# Confirm Cloud CDN serves check-update (after SSL cert is ACTIVE)
curl -I https://ota.tile.dev/api/check-update/version
# expect: HTTP/2 200, Cache-Control: public, max-age=60, s-maxage=2592000

# Confirm tenant returns candidates through CDN
curl 'https://ota.tile.dev/api/check-update/v2/t/tk_tilepacket-test/fingerprint/android/6d12336b9f6e00805a4eaa21aa1fb36249fac10a/production/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000'
# expect: { "candidates": [ ...bundles with fileUrl: "https://ota.tile.dev/t/..." ] }

# Confirm tenant isolation — different tenant gets empty candidates
curl 'https://ota.tile.dev/api/check-update/v2/t/tk_some-other-tenant/fingerprint/android/6d12336b9f6e00805a4eaa21aa1fb36249fac10a/production/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000'
# expect: { "candidates": [] }

# Confirm fails-closed — no tenant returns 400
curl -i 'https://ota.tile.dev/api/check-update/v2/fingerprint/android/6d12336b9f6e00805a4eaa21aa1fb36249fac10a/production/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000'
# expect: HTTP 400 { "error": "Tenant required..." }

# Confirm fallback URL still works (for unrebuilt old apps)
curl -I https://apptile-staging-setup.web.app/api/check-update/version

# Confirm bundle bytes have immutable cache-control via CDN
curl -I https://ota.tile.dev/t/tk_apptile-seed/{any-bundleId}/bundle.zip
# expect: HTTP/2 200, Cache-Control: public, max-age=31536000, immutable

# Confirm admin endpoints are never cached
curl -I https://ota.tile.dev/api/cli/t/tk_apptile-seed/me
# expect: HTTP/2 401, Cache-Control: private, no-store, Vary: Authorization

# After a deploy, confirm CDN invalidation fired
gcloud logging read 'resource.type=cloud_run_revision AND textPayload:"[cdn] invalidated"' --limit=5 --format="value(textPayload)"

# See Firestore databases in the project
gcloud firestore databases list --project=apptile-staging-setup

# List Cloud Functions (should show tile-push)
gcloud functions list --project=apptile-staging-setup --regions=us-central1

# Inspect Cloud CDN cache settings on the backend service
gcloud compute backend-services describe backend-checkupdate --global --format=yaml | grep -A 5 cdnPolicy
```

## Roadmap

Done:
1. ✓ Multi-tenancy: `appId` enforcement on all queries, tenant-scoped URLs (`/api/check-update/v2/t/{appId}/...`), tenant-scoped storage prefixes, tenant-scoped cache keys
2. ✓ CDN v1: Firebase Hosting fronts the function, 60s TTL on v2 paths, sub-150ms TTFB from India POPs
3. ✓ CDN v2 (2026-05-25): Google Cloud CDN + Global LB fronts `ota.tile.dev`. Per-tenant invalidation on every deploy, 30d edge TTL, immutable bundle bytes. Full GCP inventory: [`GCP_INFRASTRUCTURE.md`](./GCP_INFRASTRUCTURE.md).
4. ✓ In-memory cache layer inside Cloud Run instance (kept as belt-and-suspenders behind Cloud CDN)
5. ✓ Public bucket + cdnUrl (no signBlob hot-path latency)
6. ✓ Customer-facing `@tile-push/cli` deploy CLI (wraps hot-updater CLI; multi-tenant aware)
7. ✓ Customer-facing `@tile-push/react-native` SDK fork (baseURL = `https://ota.tile.dev`)
8. ✓ Bearer-token CLI auth (`tenants/{appId}/deployTokens[]`, SHA-256 hashed)

Not yet:
9. Per-project credentials store (multi-appId on same laptop)
10. Tenant onboarding flow + admin web console (rebrand of `@hot-updater/console`, repo: `tile-web`)
11. npm publish for `@tile-push/cli` + `@tile-push/react-native`
12. Patch generation (server-side bsdiff per asset) so devices fetch only changed bytes
13. MAU tracking compatible with CDN (Cloudflare Analytics Engine or separate `/ping` endpoint)
14. Stripe billing
15. v1 deprecation — once all clients on v2, remove the v1 routes (they currently throw because of tenant requirement)
16. POST-DEMO: migrate to Cloudflare Workers + R2 + D1 stack (~98% cost reduction at hyper-viral scale)
17. POST-DEMO: iOS bare RN integration guide
