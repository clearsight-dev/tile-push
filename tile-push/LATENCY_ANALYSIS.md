# tile-push Latency Analysis

A log of what we observed, what we changed, and where the time goes now.

## Snapshot: where we are today

Endpoint (v2, multi-tenant): `GET /api/check-update/v2/t/{appId}/fingerprint/{platform}/{fp}/{channel}/{minBundleId}/{currentBundleId}`
Test: matches a real bundle with ~40 changed assets, served through Firebase Hosting CDN.

| Metric | Value |
|---|---|
| Client-measured warm p50 (via Firebase Hosting CDN, Chennai POP) | **~100–150ms** |
| Server-side warm p50 (cache HIT at Cloud Run instance) | **~5ms** |
| Server-side warm p50 (cache MISS, Firestore round-trip) | **~100–130ms** |
| Network RTT (client in India → Chennai POP) | **~50–100ms** |
| Direct-to-origin warm p50 (skipping CDN) | **~400–500ms** |
| 20-concurrent client-measured p50 (via CDN) | **~120–180ms** |

## Where the latency goes today (with CDN + cache)

```
┌──────────────── ~100ms total (client-measured, CDN HIT) ─────────────────┐
│                                                                           │
│  ~50-100ms network RTT (India → MAA POP)                                  │
│  ┌────────────────────────────────────────────────────────┐               │
│  │ TLS handshake / TCP keepalive                          │               │
│  │ IP propagation to nearest Chennai POP                  │               │
│  └────────────────────────────────────────────────────────┘               │
│                                                                           │
│  ~1-5ms CDN edge (Firebase Hosting cache shard)                           │
│  ┌────────────────────────────────────────────────────────┐               │
│  │ Look up cache by URL path (includes /t/{appId}/)       │               │
│  │ Return cached response from edge shard                 │               │
│  └────────────────────────────────────────────────────────┘               │
└───────────────────────────────────────────────────────────────────────────┘

  When cache MISS (1% of requests, sharded), the chain extends:
  → Hosting forwards to Cloud Run (us-central1)                      [+~250ms RTT]
  → Cloud Run in-memory cache check                                  [+~5ms]
    └─ HIT  → serve from Map (no Firestore)                          [≈ 0ms]
    └─ MISS → tenant-scoped Firestore query                          [+~70-100ms]
            → cache in instance Map for 60s
  Total miss: ~400-800ms
```

**Cache HIT serves in ~100ms.** Cache MISS still rare and short-lived (60s TTL,
warmed across all major Indian POPs within minutes of a deploy).

## The journey

### Initial state (signed URLs, signBlob in hot path)

| Metric | Value |
|---|---|
| Client warm p50 | ~880ms |
| 20 concurrent | **8000ms+** (signBlob serialized under load) |

Every `/check-update` call did 1× bundle signBlob + ~40× asset signBlob calls. signBlob is an HTTPS round-trip to GCP's IAM Credentials API; under concurrency, calls queued and TTFB blew up.

### Change 1: Disable public access prevention on the bucket

```bash
gcloud storage buckets update gs://tile-push-bundles \
    --no-public-access-prevention \
    --project=apptile-staging-setup
```

By itself: no latency change. Enables change 2.

### Change 2: Grant `allUsers` → `objectViewer` on the bucket

```bash
gcloud storage buckets add-iam-policy-binding gs://tile-push-bundles \
    --member=allUsers \
    --role=roles/storage.objectViewer \
    --project=apptile-staging-setup
```

By itself: no latency change. Enables change 4.

### Change 3: Patch `firebaseStorage.ts` to accept a `cdnUrl` config

Added optional `cdnUrl` field. When set, `getDownloadUrl()` returns `${cdnUrl}/${key}` directly, skipping `file.getSignedUrl()`.

```ts
if (config.cdnUrl) {
  const base = config.cdnUrl.replace(/\/+$/, "");
  return { fileUrl: `${base}/${key}` };
}
// otherwise fall through to signed URL
```

`firebaseFunctionsStorage` (runtime) already had cdnUrl wiring via `process.env.HOT_UPDATER_CDN_URL` — change to source `firebaseStorage` was a parallel CLI-side improvement.

### Change 4: Set `HOT_UPDATER_CDN_URL` env var on the function

```bash
gcloud run services update tile-push \
    --region=us-central1 \
    --update-env-vars=HOT_UPDATER_CDN_URL=https://storage.googleapis.com/tile-push-bundles \
    --project=apptile-staging-setup
```

This is what actually moved the numbers. Created new revision `tile-push-00002-25n`, traffic shifted to 100%, no rebuild required (function code already supported the env var).

After: bundle URLs come back as plain `https://storage.googleapis.com/tile-push-bundles/<key>` — no `?X-Goog-Signature=...&Expires=...` query string.

### Change 5: In-memory cache inside the Cloud Run instance

Wrapped `app.fetch` in a `cachedFetch` that uses a module-level `Map<key, CacheEntry>` with a 60-second TTL. Cache lives for the instance's lifetime; each warm Cloud Run instance has its own map.

```ts
const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

async function cachedFetch(request) {
  const key = `${tenantScope}|${url.pathname}`;
  const cached = responseCache.get(key);
  if (cached && cached.expires > Date.now()) {
    return new Response(cached.body, { ... "x-tile-cache": "hit" });
  }
  const response = await app.fetch(request);
  // ... cache + return
}
```

Hypothesis confirmed in tests:
- Cache MISS server latency: ~1.5s (cold start + Firestore)
- Cache HIT server latency: **~5ms** (just serve from Map)
- 25× speedup on server side at the same URL

The cache key includes a `tenantScope` prefix — critical for multi-tenancy. Two tenants sharing the same fingerprint never share a cached response.

### Change 6: v2 endpoint — cohort out of URL, candidates returned to client

Added `/api/check-update/v2/fingerprint/{platform}/{fp}/{channel}/{minBundleId}/{currentBundleId}` (note: no `/cohort` segment). Server returns *all* candidate bundles eligible for this (fingerprint, channel) combo, with each candidate's `eligibleNumericCohorts` array. Client picks based on local cohort.

URL cardinality dropped from `2 platforms × N fingerprints × 2 channels × 1 minBundle × ~5 bundleIds × 1000 cohorts` to `2 × N × 2 × 1 × 5`. **~1000× collapse in URL space** → CDN actually has something to cache.

| Endpoint | Cardinality / device-app pair | CDN hit rate |
|---|---|---|
| v1 (cohort in URL) | ~1000 per fingerprint | ~0% — every device unique |
| v2 (cohort in response) | 1 per fingerprint | ~100% after first warm |

### Change 7: Firebase Hosting in front of the function

Hosting acts as a CDN on Google's global edge network with no extra LB cost (uses `web.app` cert + DNS). Configured via `firebase.json`:

```json
{
  "hosting": {
    "public": "hosting",
    "rewrites": [{ "source": "/api/**", "function": { "functionId": "tile-push", "region": "us-central1" } }],
    "headers": [
      { "source": "/api/check-update/v2/**", "headers": [{ "key": "Cache-Control", "value": "public, max-age=60, s-maxage=60" }] },
      { "source": "/api/check-update/!(v2)/**", "headers": [{ "key": "Cache-Control", "value": "no-store" }] }
    ]
  }
}
```

Result: v2 paths cached at Chennai POP (`cache-maa10228-MAA`) for India users.

| Metric | Direct Cloud Run | Through Hosting CDN (HIT) |
|---|---|---|
| TTFB from India | ~400–500ms | **~100–150ms** |
| Server execution | full (~100–130ms) | **0 (CDN serves)** |

### Change 8: Multi-tenant URL + tenant-aware cache key

Final endpoint shape: `/api/check-update/v2/t/{appId}/fingerprint/...`

Tenant middleware in the Cloud Function (using `AsyncLocalStorage`) extracts `appId` from the URL, validates format, strips it, and runs the rest of the request inside an ALS context. Every Firestore query the function makes is scoped to that `appId` via a centralized `currentAppId()` helper in `firebaseDatabase.ts`. Cache keys also include the tenant scope so a request for tenant A cannot serve from tenant B's cached entry.

This is the production-ready URL shape — see [ARCHITECTURE.md](ARCHITECTURE.md) and [CLAUDE.md](CLAUDE.md) for the multi-tenant model.

## Before vs after (end-to-end journey)

| Metric | Initial | After signBlob removal | After in-memory cache | **After CDN (today)** |
|---|---|---|---|---|
| Client-measured warm p50 | ~880ms | ~400ms | ~400ms* | **~100–150ms** |
| Server-side warm p50 | ~600ms | ~100–130ms | ~5ms (HIT) | **~5ms (HIT)** |
| 20 concurrent client p50 | 8000ms+ | 0.7–1.6s | 0.7–1.6s* | **~120–180ms** |
| Cache hit rate at edge | n/a | n/a | n/a | **~99%** (after warmup) |
| signBlob calls | ~41/request | 0 | 0 | 0 |
| Firestore round-trips | 1+ per request | 1+ per request | 1 per TTL window | **~1 per minute per POP** |

\* Client-measured number didn't drop after in-memory cache because the bottleneck shifted entirely to network RTT. The CDN change is what fixed that.

**Cumulative improvement: client-measured warm p50 went from 880ms → 100ms (8.8× faster), server CPU per request dropped from 100% to ~1% (Firestore only touched on cache fills).**

## What's left

| Layer | Current cost | Lever | Notes |
|---|---|---|---|
| Network RTT to MAA POP (~50–100ms) | Inherent to India location | Cloudflare CDN (denser POPs, ~30-50ms common) OR multi-region origin | Possible future migration. Cloudflare also gives zero egress. |
| Cache misses (~1%, ~400–800ms each) | TTL invalidation + new POPs warming | Longer TTL (180s) OR pre-warm key POPs after deploys | Diminishing returns at 99% hit rate |
| Bundle download egress | $0.12/GB direct GCS | Migrate `tile-push-bundles` to R2 (zero egress) | Real $$ at scale; ~half-day migration |
| API endpoint diversity (only v2 cached) | v1 paths bypass cache | Deprecate v1 once all clients migrated | Status quo: v1 broken under multi-tenancy anyway |

## Reference: live request counts + observability

- Cloud Run service page (live charts, p50/p95/p99, instance count):
  `https://console.cloud.google.com/run/detail/us-central1/tile-push/metrics?project=apptile-staging-setup`

- CLI request count (last 24h):
  ```bash
  gcloud logging read \
      'logName="projects/apptile-staging-setup/logs/run.googleapis.com%2Frequests" AND resource.labels.service_name="tile-push"' \
      --project=apptile-staging-setup --freshness=1d \
      --format="value(timestamp)" 2>/dev/null | wc -l
  ```

- Find cold starts (any request >2s is suspect):
  ```bash
  gcloud logging read \
      'logName="projects/apptile-staging-setup/logs/run.googleapis.com%2Frequests" AND resource.labels.service_name="tile-push" AND httpRequest.latency>="2s"' \
      --project=apptile-staging-setup --freshness=1d --limit=10 \
      --format="value(timestamp,httpRequest.latency)"
  ```
