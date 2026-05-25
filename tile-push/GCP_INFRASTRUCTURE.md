# tile-push — GCP Infrastructure Reference

**Purpose:** an exhaustive, name-by-name inventory of every Google Cloud resource that backs tile-push. This is the "rollback bible" — if we ever need to tear down or recreate the production infra, every name, value, dependency, and gcloud command lives here.

Last updated: 2026-05-25

---

## TL;DR — what runs where

```
                          AWS Route 53 (tile.dev hosted zone)
                                  ota.tile.dev  A  8.233.151.195
                                          │
                                          ▼
   ┌──────────────────── Google Cloud project: apptile-staging-setup ───────────────────┐
   │                                                                                    │
   │   Static IP (global): tile-push-lb-ip = 8.233.151.195                              │
   │                                          │                                         │
   │                                          ▼                                         │
   │   Forwarding rule: tile-push-fr  ──►  Target HTTPS proxy: tile-push-https         │
   │   (port 443, global)                       │     │                                 │
   │                                            │     └─ SSL cert: tile-push-cert-v2   │
   │                                            ▼                                       │
   │                                  URL map: tile-push-lb                            │
   │                            (host: ota.tile.dev, path-routed)                       │
   │                                            │                                       │
   │       ┌────────────────────────────────────┼──────────────────────────────────┐   │
   │       │                                    │                                  │   │
   │   /api/check-update/*              /api/cli/*, /ping                  default │   │
   │       │                                    │                                  │   │
   │       ▼                                    ▼                                  ▼   │
   │  backend-checkupdate                backend-admin                  backend-bundles │
   │  Cloud CDN: ON                      Cloud CDN: OFF                Cloud CDN: ON  │
   │  query string excluded              (no-store responses)          (immutable bytes)│
   │       │                                    │                                  │   │
   │       │                                    │                                  ▼   │
   │       └──────► Serverless NEG ◄────────────┘                       GCS bucket:   │
   │                tile-push-neg (us-central1)                        tile-push-bundles│
   │                          │                                       (public-read,    │
   │                          ▼                                        immutable cache)│
   │                Cloud Run service: tile-push                                       │
   │                (us-central1, Gen 2 firebase function)                             │
   │                          │                                                        │
   │                          ▼                                                        │
   │                Firestore: tile-push (named DB, us-central1)                      │
   │                                                                                   │
   │   Also still alive (legacy + fallback): Firebase Hosting                          │
   │   https://apptile-staging-setup.web.app/* → same Cloud Run service                │
   └───────────────────────────────────────────────────────────────────────────────────┘
```

---

## Project + identity

| Item | Value |
|---|---|
| GCP project ID | `apptile-staging-setup` |
| GCP project number | `1097788179850` |
| Region | `us-central1` |
| Primary admin account | `yaswanth.a@apptile.io` |
| Cloud Run service account | `1097788179850-compute@developer.gserviceaccount.com` (default compute SA) |
| SA roles in use | `roles/editor`, `roles/run.invoker` |

The default compute SA's `roles/editor` already includes `compute.urlMaps.invalidateCache` — no additional IAM grant needed for CDN invalidation calls from the Cloud Run service.

---

## Domain + DNS

| Item | Value | Where it lives |
|---|---|---|
| Apex domain | `tile.dev` | Owned at AWS Route 53 (not GCP) |
| OTA subdomain | `ota.tile.dev` | A record → `8.233.151.195` (Google LB), TTL 300 |
| Hosted zone | `tile.dev` | AWS Route 53 (nameservers: `ns-{87,580,1274,1896}.awsdns-*`) |
| Other tile.dev records | apex, www, beta, docs, cdn-demo, demo-setup, dev, api — **not touched, all still pointing where they were** | Same Route 53 zone |

**Verify:**
```bash
dig ota.tile.dev @8.8.8.8 +short   # should return 8.233.151.195
```

**To remove the record:** AWS Route 53 console → tile.dev hosted zone → select `ota` A record → Delete. No GCP-side change needed.

---

## Cloud Run service (the Cloud Function)

| Item | Value |
|---|---|
| Service name | `tile-push` |
| Region | `us-central1` |
| Default URL | `https://tile-push-io7lmh2oqa-uc.a.run.app` |
| Generation | Gen 2 (firebase-functions v2 = Cloud Run under the hood) |
| Container image | `us-central1-docker.pkg.dev/apptile-staging-setup/gcf-artifacts/apptile--staging--setup__us--central1__tile--push:version_N` |
| Deployed from | `plugins/firebase/deploy/functions/` via `firebase deploy --only functions` |
| Function export | `tile.push` (firebase encodes hyphenated function names as nested) |

### Environment variables (set on Cloud Run, persisted across deploys via firebase functions config)

| Var | Value | Used by |
|---|---|---|
| `FIREBASE_CONFIG` | `{"projectId":"apptile-staging-setup","storageBucket":"apptile-staging-setup.firebasestorage.app"}` | firebase-admin |
| `GCLOUD_PROJECT` | `apptile-staging-setup` | Used by invalidation code to scope `urlMaps.invalidateCache` |
| `EVENTARC_CLOUD_EVENT_SOURCE` | `projects/.../tile-push` | firebase-functions auto-set |
| `FUNCTION_TARGET` | `tile.push` | firebase-functions runtime |
| `LOG_EXECUTION_ID` | `true` | log correlation |
| `HOT_UPDATER_CDN_URL` | `https://ota.tile.dev` | firebaseFunctionsStorage — transforms `gs://` URIs into device-facing CDN URLs |

**Verify:**
```bash
gcloud run services describe tile-push --region=us-central1 \
  --format="value(spec.template.spec.containers[0].env)"
```

### Code that lives in the function

| File (source) | Purpose |
|---|---|
| [`plugins/firebase/firebase/functions/index.ts`](../plugins/firebase/firebase/functions/index.ts) | Function entry. Tenant URL parsing, CLI route dispatch, Cache-Control headers per path |
| [`plugins/firebase/firebase/functions/cliRoutes.ts`](../plugins/firebase/firebase/functions/cliRoutes.ts) | `/api/cli/*` routes for deploy CLI — upload URLs, bundle CRUD, Cloud CDN invalidation hook |
| [`plugins/firebase/firebase/functions/cliAuth.ts`](../plugins/firebase/firebase/functions/cliAuth.ts) | Bearer token auth middleware (SHA-256 hashed tokens in `tenants/{appId}/deployTokens[]`) |
| [`plugins/firebase/firebase/functions/getUpdateInfo.ts`](../plugins/firebase/firebase/functions/getUpdateInfo.ts) | (unused now — superseded by upstream handler) |
| [`plugins/firebase/src/firebaseDatabase.ts`](../plugins/firebase/src/firebaseDatabase.ts) | Firestore plugin, tenant-aware |
| [`plugins/firebase/src/firebaseFunctionsStorage.ts`](../plugins/firebase/src/firebaseFunctionsStorage.ts) | Runtime storage plugin — applies `cdnUrl` env var to transform gs:// URIs |
| [`plugins/firebase/src/tenantContext.ts`](../plugins/firebase/src/tenantContext.ts) | `AsyncLocalStorage`-based tenant context |

---

## Load Balancer stack (Cloud CDN front-end)

All resources are **global**, not regional. Created via gcloud CLI on 2026-05-25.

### 1. Static external IP

| Item | Value |
|---|---|
| Name | `tile-push-lb-ip` |
| Type | Global, external |
| IP | `8.233.151.195` |
| Cost | $0 while attached to a forwarding rule, $7.30/mo if dangling |

```bash
gcloud compute addresses describe tile-push-lb-ip --global
```

### 2. SSL certificate (Google-managed)

| Item | Value |
|---|---|
| Name | `tile-push-cert-v2` |
| Type | MANAGED |
| Domains | `ota.tile.dev` |
| Status | `PROVISIONING` initially → `ACTIVE` after DNS-based validation (typically 15-60 min) |
| Auto-renew | Yes, on each renewal cycle |
| Cost | $0 |

```bash
gcloud compute ssl-certificates describe tile-push-cert-v2 --global \
  --format="value(managed.status,managed.domainStatus)"
```

**Note:** the original cert `tile-push-cert` hit `FAILED_NOT_VISIBLE` because it was created before DNS was wired up. It was deleted and replaced with `tile-push-cert-v2`. Future-proof: always create the cert **after** the DNS A record exists.

### 3. Serverless Network Endpoint Group (NEG)

| Item | Value |
|---|---|
| Name | `tile-push-neg` |
| Region | `us-central1` |
| Type | `serverless` |
| Target | Cloud Run service `tile-push` |
| Cost | $0 |

```bash
gcloud compute network-endpoint-groups describe tile-push-neg --region=us-central1
```

The NEG is a glue object — it tells backend services "the target is this Cloud Run service." A backend service references the NEG, not the Cloud Run service directly.

### 4. Backend services + bucket (three of them)

#### 4a. `backend-checkupdate` (Cloud CDN ON, for `/api/check-update/*`)

| Setting | Value |
|---|---|
| Load balancing scheme | `EXTERNAL_MANAGED` |
| Protocol | HTTP (LB→Cloud Run is internal, port_name must be unset for serverless NEGs) |
| Backend | NEG `tile-push-neg` |
| Cloud CDN | ENABLED |
| Cache mode | `USE_ORIGIN_HEADERS` (respects `Cache-Control` from Cloud Run response) |
| Cache key — include query string | NO (so `?currentBundleId=x` doesn't fragment the cache) |
| Cache key — include host, protocol, path | YES (defaults) |
| Negative caching | ENABLED (4xx/5xx cached briefly per defaults) |
| **Compression mode** | **`AUTOMATIC`** (gzip JSON responses at edge — set 2026-05-25) |

```bash
gcloud compute backend-services describe backend-checkupdate --global
```

**Compression behavior:** Cloud CDN serves a gzipped version to any client sending `Accept-Encoding: gzip`. On first cache fill after this setting was enabled, Cloud CDN compresses the origin response (52 KB JSON → 14 KB gzipped) and caches both versions, serving the right one based on the client's `Vary: Accept-Encoding` header. Saves ~75% wire bytes per request, ~100ms on cold calls. Reversal: `--compression-mode=DISABLED`.

#### 4b. `backend-admin` (Cloud CDN OFF, for `/api/cli/*` and `/ping`)

| Setting | Value |
|---|---|
| Load balancing scheme | `EXTERNAL_MANAGED` |
| Protocol | HTTP |
| Backend | NEG `tile-push-neg` (same as checkupdate) |
| Cloud CDN | DISABLED |
| Compression mode | N/A (Google requires Cloud CDN enabled to set compression) |

CLI deploy/auth flows are POST/PATCH/DELETE with Bearer tokens. Never cacheable.

**Why no compression here (considered + skipped 2026-05-25):** Cloud CDN's `compression-mode` requires Cloud CDN to be enabled on the backend. We deliberately keep Cloud CDN OFF on admin to make it structurally impossible for any auth-scoped response to ever land in a cache — even if a code regression accidentally drops the `no-store` header. The potential bandwidth saving was ~50 MB / ~$0.01 per month at realistic scale, well below the risk of weakening this guardrail. If we ever ship a `GET /bundles` admin response that's routinely >50 KB per call we'd revisit.

#### 4c. `backend-bundles` (Cloud CDN ON, for `/*` default — bundle bytes)

| Setting | Value |
|---|---|
| Backend type | **backend bucket** (not backend service) |
| GCS bucket | `tile-push-bundles` |
| Cloud CDN | ENABLED |
| Cache mode | `USE_ORIGIN_HEADERS` (respects `Cache-Control` from GCS object metadata) |

```bash
gcloud compute backend-buckets describe backend-bundles
```

**Important:** "backend bucket" is Google's confusing term — it's a load-balancer config object that wraps an existing GCS bucket. The actual bytes live in `gs://tile-push-bundles`, which is the same bucket we always had.

### 5. URL map (routing rules)

| Item | Value |
|---|---|
| Name | `tile-push-lb` |
| Default service (no host match) | `backend-admin` |
| Path matcher | `ota-paths` |
| Host rule | `ota.tile.dev` → `ota-paths` matcher |

`ota-paths` matcher:

| Path | Target |
|---|---|
| `/api/check-update/*` | `backend-checkupdate` |
| `/api/cli/*` | `backend-admin` |
| `/ping` | `backend-admin` |
| **default (anything else)** | `backend-bundles` (the GCS bucket) |

This is why bundle URLs look like `https://ota.tile.dev/t/{appId}/{bundleId}/bundle.zip` — there's no explicit `/storage/` prefix, the path just falls through to the bucket.

```bash
gcloud compute url-maps describe tile-push-lb
```

### 6. Target HTTPS proxy

| Item | Value |
|---|---|
| Name | `tile-push-https` |
| URL map | `tile-push-lb` |
| SSL cert(s) | `tile-push-cert-v2` |

```bash
gcloud compute target-https-proxies describe tile-push-https
```

### 7. Global forwarding rule (the LB's entry point)

| Item | Value |
|---|---|
| Name | `tile-push-fr` |
| Scope | Global |
| Address | `tile-push-lb-ip` (`8.233.151.195`) |
| Port | 443 |
| Target | `tile-push-https` |
| Cost | **~$18/mo flat + ~$0.008/GB data processed** |

This is the only LB resource that bills. Reversible: `gcloud compute forwarding-rules delete tile-push-fr --global`.

```bash
gcloud compute forwarding-rules describe tile-push-fr --global
```

---

## GCS bucket

| Item | Value |
|---|---|
| Bucket | `gs://tile-push-bundles` |
| Region | `us-central1` |
| Storage class | Standard |
| Public-read IAM | `allUsers: roles/storage.objectViewer` (set 2026-05-25) |
| Object-level Cache-Control | `public, max-age=31536000, immutable` on all existing objects (bulk-patched 2026-05-25); new uploads set this header via the signed PUT URL from the deploy server |

Path layout inside the bucket:
```
gs://tile-push-bundles/
├── t/                                 ← tenant prefix (new bundles)
│   └── {appId}/
│       └── {bundleId}/
│           ├── bundle.zip
│           ├── manifest.json
│           └── assets/sha256/{xx}/{hash}.png
├── 019e5014-.../                      ← legacy bundles (pre-tenant-prefix), still readable
├── 019e5315-.../
└── 019e531a-.../
```

The legacy bundles were created before the multi-tenant migration. They still have valid `storage_uri` references in Firestore and continue to work. New bundles all live under `t/{appId}/`.

**Bundle URL that devices see:**
```
https://ota.tile.dev/t/{appId}/{bundleId}/bundle.zip
                    └─ resolved by URL map → backend-bundles → gs://tile-push-bundles/t/{appId}/{bundleId}/bundle.zip
```

The URL path == GCS object path. No URL rewrite needed.

**Verify object metadata:**
```bash
gcloud storage objects describe "gs://tile-push-bundles/t/tk_apptile-seed/{bundleId}/bundle.zip" \
  --format="value(cacheControl,contentType)"
# expect: public, max-age=31536000, immutable | application/zip
```

---

## Firestore

| Item | Value |
|---|---|
| Database name | `tile-push` (named DB, **not** `(default)`) |
| Region | `us-central1` |
| Mode | Native |
| Collections | `bundles`, `tenants`, `channels`, `target_app_versions` |
| Composite indexes | 8 indexes, all start with `app_id ASC` — see [`firestore.indexes.json`](../plugins/firebase/firebase/public/firestore.indexes.json) |
| Multi-tenancy enforcement | Plugin-level — `.where("app_id", "==", appId)` on every query, `app_id` in every doc write |
| Deploy tokens collection | `tenants/{appId}/deployTokens[]` — SHA-256 hashed |

```bash
gcloud firestore databases describe --database=tile-push
```

---

## Firebase Hosting (still alive, kept as fallback)

| Item | Value |
|---|---|
| Site | `apptile-staging-setup` |
| Public URL | `https://apptile-staging-setup.web.app` (also `https://apptile-staging-setup.firebaseapp.com`) |
| Config | [`plugins/firebase/firebase/public/firebase.json`](../plugins/firebase/firebase/public/firebase.json) |
| Rewrite | `/api/**` → Cloud Run function `tile-push` with `pinTag: true` |
| Cache-Control on `/api/check-update/v2/**` | `public, max-age=60, s-maxage=60` (legacy, overridden by Cache-Control in Cloud Run response since deploy) |

Firebase Hosting still works as a fallback. The pre-existing apptile-seed and tilepacket apps that haven't been rebuilt with the new SDK URL continue to hit this URL.

**Plan:** keep Firebase Hosting alive for at least one week post-CDN-cutover. Decommission only after all consumer apps are rebuilt against `ota.tile.dev`.

---

## Cache-Control headers (the contract)

| URL pattern | Header set by | Header value | CDN behavior |
|---|---|---|---|
| `/api/check-update/*` | Cloud Run code, in `index.ts` | `public, max-age=60, s-maxage=2592000` | Edge holds for 30 days, invalidated per tenant on deploy. **Gzipped at edge** (`Vary: Accept-Encoding`, ~3.6× compression). |
| `/api/cli/*` | Cloud Run code, in `index.ts` | `private, no-store` + `Vary: Authorization` | Never cached |
| `/ping` | Cloud Run code (default Hono) | none | Routed to backend-admin (Cloud CDN OFF) |
| `/t/{appId}/{bundleId}/**` (bundle bytes) | GCS object metadata | `public, max-age=31536000, immutable` | Cached at edge for 1 year, never revalidates. **Not gzipped** (zip files are already compressed). |
| `/t/{appId}/assets/sha256/**` (asset patches) | GCS object metadata | same as bundles | same |

---

## Cache invalidation (per-tenant, on every deploy)

When the CLI POSTs `/api/cli/t/{appId}/bundles`, after the Firestore commit succeeds, the function calls:

```http
POST https://compute.googleapis.com/compute/v1/projects/apptile-staging-setup/global/urlMaps/tile-push-lb/invalidateCache
Authorization: Bearer {token-from-metadata-server}
Content-Type: application/json

{"path": "/api/check-update/v2/t/{appId}/*"}
```

This wipes all check-update cache entries for that tenant across the global edge fleet. Propagation: typically <60s, P99 ~3 min.

**Quota:** 1,000 free invalidations per project per month, $0.005 each beyond that. At 1000 tenants × 4 deploys/mo we use 4000 invalidations → 3000 paid → $15/mo. Well within budget.

**Source:** [`plugins/firebase/firebase/functions/cliRoutes.ts`](../plugins/firebase/firebase/functions/cliRoutes.ts) — `invalidateTenantCache(appId)` function. Failure here logs and proceeds — never blocks the deploy.

**Verify in logs after a deploy:**
```bash
gcloud logging read 'resource.type=cloud_run_revision AND textPayload:"[cdn] invalidated"' \
  --limit=5 --format="value(textPayload)"
```

---

## URL routing summary (every customer-facing URL)

| URL pattern | Routed by | Backend | Cached |
|---|---|---|---|
| `https://ota.tile.dev/api/check-update/v2/t/{appId}/...` | URL map | `backend-checkupdate` → Cloud Run | 30d, per-tenant invalidate |
| `https://ota.tile.dev/api/check-update/version` | URL map | `backend-checkupdate` → Cloud Run | 30d |
| `https://ota.tile.dev/api/cli/t/{appId}/bundles` | URL map | `backend-admin` → Cloud Run | NEVER |
| `https://ota.tile.dev/api/cli/t/{appId}/upload-url` | URL map | `backend-admin` → Cloud Run | NEVER |
| `https://ota.tile.dev/api/cli/t/{appId}/me` | URL map | `backend-admin` → Cloud Run | NEVER |
| `https://ota.tile.dev/t/{appId}/{bundleId}/bundle.zip` | URL map default | `backend-bundles` → GCS object | 1 year, immutable |
| `https://ota.tile.dev/t/{appId}/{bundleId}/manifest.json` | URL map default | `backend-bundles` → GCS object | 1 year, immutable |
| `https://ota.tile.dev/t/{appId}/assets/sha256/**` | URL map default | `backend-bundles` → GCS object | 1 year, immutable |
| `https://ota.tile.dev/ping` | URL map | `backend-admin` → Cloud Run | NEVER (Hono response) |

The legacy Firebase Hosting URL `https://apptile-staging-setup.web.app/*` still works for `/api/**` paths via Hosting's rewrite to the same Cloud Run service.

---

## What runs where — quick mental model

| Request type | Hot path | Cold path (cache miss) |
|---|---|---|
| Device checks for update | Google's edge POP serves from cache (~5ms) | LB → backend-checkupdate → Cloud Run → Firestore (~150ms) |
| Device downloads bundle | Google's edge POP serves from cache (~5ms-50ms depending on bundle size) | LB → backend-bundles → GCS (~200ms first byte) |
| CLI deploys | LB → backend-admin → Cloud Run → signed URL → CLI uploads to GCS direct (bypasses LB) → CLI POSTs metadata → Cloud Run writes Firestore → invalidates cache | (no cache layer to miss) |

---

## Complete teardown commands (if we ever need to revert)

Run in this order to cleanly remove everything we created on 2026-05-25, in reverse-dependency order:

```bash
# 1. Stop traffic (deletes the only billing resource)
gcloud compute forwarding-rules delete tile-push-fr --global --quiet

# 2. Delete the HTTPS proxy
gcloud compute target-https-proxies delete tile-push-https --quiet

# 3. Delete the URL map (frees its backend references)
gcloud compute url-maps delete tile-push-lb --quiet

# 4. Delete backend services + bucket
gcloud compute backend-services delete backend-checkupdate --global --quiet
gcloud compute backend-services delete backend-admin --global --quiet
gcloud compute backend-buckets delete backend-bundles --quiet

# 5. Delete the NEG
gcloud compute network-endpoint-groups delete tile-push-neg --region=us-central1 --quiet

# 6. Delete the SSL cert
gcloud compute ssl-certificates delete tile-push-cert-v2 --global --quiet

# 7. Release the static IP (must be detached first — already done by step 1)
gcloud compute addresses delete tile-push-lb-ip --global --quiet

# 8. Revoke public read on the bucket (optional — only if reverting public bundle model)
gcloud storage buckets remove-iam-policy-binding gs://tile-push-bundles \
  --member=allUsers --role=roles/storage.objectViewer

# 9. Revert env var on Cloud Run (next firebase deploy will re-set defaults)
gcloud run services update tile-push --region=us-central1 \
  --remove-env-vars=HOT_UPDATER_CDN_URL
```

### DNS cleanup (AWS Route 53)

AWS Route 53 console → tile.dev hosted zone → select `ota` A record → Delete.

### Code revert (git)

The following files were modified on 2026-05-25 for the CDN migration. Revert these commits to roll back the code side:

- [`plugins/firebase/firebase/functions/index.ts`](../plugins/firebase/firebase/functions/index.ts) — Cache-Control headers, cdnUrl default
- [`plugins/firebase/firebase/functions/cliRoutes.ts`](../plugins/firebase/firebase/functions/cliRoutes.ts) — invalidation hook, immutable upload header
- [`packages/tile-push-react-native/src/index.ts`](../packages/tile-push-react-native/src/index.ts) — `DEFAULT_API_URL`
- [`packages/tile-push-cli/src/auth/tokenStore.ts`](../packages/tile-push-cli/src/auth/tokenStore.ts) — `DEFAULT_API_URL`

Then re-deploy: `cd plugins/firebase/deploy && firebase deploy --only functions,hosting --project=apptile-staging-setup`.

### What does NOT need to be undone in a rollback

These resources existed before today and are not tile-push-CDN-specific:
- Cloud Run service `tile-push` itself
- Firestore database `tile-push`
- GCS bucket `tile-push-bundles`
- Firebase Hosting site `apptile-staging-setup`
- Service accounts
- Other domain records in Route 53

The CDN migration is purely additive on top of those.

---

## Quick health checks

```bash
# Resources we created today, single-shot summary:
gcloud compute addresses list --global --filter="name:tile-push*" --format="table(name,address,status)"
gcloud compute ssl-certificates list --global --filter="name:tile-push*" --format="table(name,managed.status,managed.domainStatus)"
gcloud compute network-endpoint-groups list --filter="name:tile-push*" --format="table(name,region,type,cloudRun.service)"
gcloud compute backend-services list --global --filter="name:backend-*" --format="table(name,backends.group,cdnPolicy.cacheMode)"
gcloud compute backend-buckets list --filter="name:backend-bundles" --format="table(name,bucketName,enableCdn)"
gcloud compute url-maps list --filter="name:tile-push*" --format="table(name,defaultService)"
gcloud compute target-https-proxies list --filter="name:tile-push*" --format="table(name,urlMap,sslCertificates)"
gcloud compute forwarding-rules list --global --filter="name:tile-push*" --format="table(name,IPAddress,target)"

# End-to-end smoke test (after SSL is ACTIVE):
curl -I https://ota.tile.dev/api/check-update/version
# expect: HTTP/2 200, Cache-Control: public, max-age=60, s-maxage=2592000

curl -I https://ota.tile.dev/t/tk_apptile-seed/{any-bundleId}/bundle.zip
# expect: HTTP/2 200, Cache-Control: public, max-age=31536000, immutable

curl -I https://ota.tile.dev/api/cli/t/tk_apptile-seed/me
# expect: HTTP/2 401, Cache-Control: private, no-store, Vary: Authorization
```

---

## Cost ledger (current state)

| Line | Demo (light traffic) | Realistic (1000 tenants × 2.8M DAU) |
|---|---|---|
| Forwarding rule | $18/mo flat | $18 |
| LB data processing ($0.008/GB) | <$1 | $358 |
| Cloud CDN egress | <$1 | $2,714 |
| Cloud CDN cache lookups | <$1 | $189 |
| Cache invalidations (1000 free, $0.005 each) | $0 | $15 |
| Cloud Run requests + compute | $0 (free tier) | $20 |
| GCS storage | $0.50 | $3 |
| Firestore reads | $0 (free tier) | $0 |
| **Total** | **~$20/mo, all credits** | **~$3,317/mo, all credits** |

Sourced from [`tile-push/ROADMAP.md`](./ROADMAP.md) cost-analysis section.

---

## Migration runbook (Google → Cloudflare, when ready)

The whole stack was designed to be DNS-portable. Migration to Cloudflare requires:

1. Set up Cloudflare Workers + R2 + KV cache layer (server-side rewrite)
2. Configure Cloudflare zone for `tile.dev` (or just `ota.tile.dev` via subdomain delegation)
3. In AWS Route 53: change `ota.tile.dev` from `A 8.233.151.195` → `CNAME tilepush.workers.dev` (or your Cloudflare custom hostname)
4. Wait DNS propagation (~5 min with our TTL 300)
5. Run the [teardown commands above](#complete-teardown-commands-if-we-ever-need-to-revert)

**Customer-facing impact: zero.** The SDK URL `https://ota.tile.dev` stays identical; only what's behind it changes.

See [`tile-push/ROADMAP.md`](./ROADMAP.md) Cloudflare migration section for full cost analysis (~98% savings at hyper-viral scale).
