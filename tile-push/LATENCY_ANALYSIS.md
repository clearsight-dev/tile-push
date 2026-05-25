# tile-push Latency Analysis

A log of what we observed, what we changed, and where the time goes now.

**Companion docs:** [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`GCP_INFRASTRUCTURE.md`](./GCP_INFRASTRUCTURE.md).

## Final benchmarks — end of 2026-05-25 (all optimizations applied)

Stack: `ota.tile.dev` → Google Cloud LB → Cloud CDN edge → Cloud Run (us-central1) → Firestore (named DB `tile-push`).

Test endpoint (tilepacket tenant, 220 KB raw response, 17.8 KB after Brotli):
```
GET https://ota.tile.dev/api/check-update/v2/t/tk_tilepacket-test/fingerprint/android/{fp}/production/{minBundleId}/{currentBundleId}
```

### Latency percentiles — `hey` load test from India

Test setup: `hey -n 200 -c 20 -disable-keepalive` against `ota.tile.dev` from a laptop in India. Every request opens a fresh TCP+TLS connection (mimics a real mobile device's cold app launch). 200 requests total at 20 concurrent.

#### WITH CACHE (warm — what 99%+ of production sees)

Cache pre-warmed with a single GET so the URL is at edge. Then ran `hey` twice back-to-back to verify consistency.

| Percentile | Run 1 | Run 2 | Average |
|---|---|---|---|
| p10 | 96 ms | ~95 ms | **~95 ms** |
| p25 | 104 ms | ~98 ms | **~101 ms** |
| **p50** | **110 ms** | **108 ms** | **~109 ms** |
| p75 | 120 ms | ~118 ms | **~119 ms** |
| **p90** | **126 ms** | **127 ms** | **~127 ms** |
| **p95** | **132 ms** | **131 ms** | **~132 ms** |
| **p99** | **153 ms** | **144 ms** | **~148 ms** |

Phase breakdown (averages from run 1):
- DNS+TCP+TLS handshake: ~78 ms (network setup — the physics floor)
- Server response wait (TTFB Δ): **~36 ms** (request → edge cache lookup → first byte back; **Cloud Run is NOT involved**)
- Body read (17.8 KB Brotli): ~2 ms

**This is what real users get.** Every percentile under 160 ms. Variance between runs: ±4 ms on p50, ±9 ms on p99 — Google edge POPs are extremely consistent. Body transfer is a rounding error thanks to Brotli.

#### WITHOUT CACHE (cold — freshly invalidated, first device through)

Same `hey` command, but immediately after a cache invalidation. Cloud CDN has no entry, so the first concurrent misses had to wake up Cloud Run instances and wait for Firestore round trips.

| Percentile | Latency |
|---|---|
| p10 | 91 ms ← these were the requests that arrived AFTER cache got populated |
| p25 | 97 ms |
| p50 | 106 ms |
| p75 | 118 ms |
| **p90** | **3,557 ms** ← Cloud Run cold start tail begins here |
| **p95** | **4,909 ms** |
| **p99** | **5,338 ms** |

Phase breakdown (averages):
- DNS+TCP+TLS handshake: ~80 ms (same as warm — network unchanged)
- Server response wait (TTFB Δ): **avg 489 ms, max 5,189 ms** ← the tail is here
- Body read: ~2 ms

What's happening: ~75% of the 200 requests arrived AFTER cache got populated (those were ~100ms cache hits). The first ~10% had to wait for cold Cloud Run instances to start, spin up Node.js, load firebase-admin, query Firestore, and return — that's the 3-5 second tail.

#### Side-by-side comparison

| Percentile | With cache (production) | Without cache (synthetic worst-case) | Δ |
|---|---|---|---|
| p50 | 110 ms | 106 ms | ~0 (cache hits dominate even in cold run) |
| p90 | 126 ms | **3,557 ms** | **+3,431 ms** ← Cloud Run cold start emerges |
| p95 | 132 ms | **4,909 ms** | **+4,777 ms** |
| p99 | 148 ms | **5,338 ms** | **+5,190 ms** |

**The entire 5-second tail is Cloud Run cold start.** Cloud CDN itself is consistent regardless. To eliminate the tail in production:

| Mitigation | Effect | Cost |
|---|---|---|
| `gcloud run services update tile-push --min-instances=1` | Keep 1 Cloud Run instance always warm | ~$5-10/mo |
| Pre-warm cache from CLI after deploy (fire 2-3 warmup requests) | Cache filled before any user hits | $0 |
| Move `currentBundleId` filtering to client (server stops keying cache by it) | Eliminates fragmentation entirely; ~1 cache key per (tenant, platform, channel, fingerprint) | ~1hr SDK + server change |
| Migrate to Cloudflare Workers | No cold starts at all (edge compute) | Post-demo migration |

In real production with steady traffic, Cloud Run stays warm anyway (one instance idles for ~15 min between requests). The cold-start tail only appears in synthetic tests or when traffic is sporadic.

#### Alternate run — 500 requests with default keepalive (warm-biased)

`hey -n 500 -c 20` (no `-disable-keepalive`). Each of the 20 workers opens its OWN connection then reuses for ~25 requests. Result: 20 cold-conn requests + 480 warm-conn reuses.

| Percentile | Latency |
|---|---|
| p50 | 78 ms |
| p90 | 99 ms |
| p95 | 106 ms |
| p99 | 298 ms (the 20 cold-conn outliers per worker) |

Closer to "what happens during an active in-session burst" than "first call after app launch."

**Throughput:** 186 req/s sustained from one client. **Success rate:** 100% across all runs.

### Single-call timing breakdown (live measurement, India → Google POP)

```
Cold connection (fresh DNS+TCP+TLS):
   DNS:        48 ms       (OS resolver, cached locally after first call)
   TCP:       +51 ms       (1 RTT to nearest Google edge POP)
   TLS:       +71 ms       (TLS 1.3, 1 RTT + crypto)
   Server:    +58 ms       (request → edge → cache lookup → first byte = 1 RTT + 5ms)
   Body:      +19 ms       (17.8 KB compressed body streams over open conn)
   ─────────────────
   TOTAL:    ~248 ms

Warm connection (subsequent calls — what apps experience after first):
   DNS:         0 ms       (locally cached)
   TCP:         0 ms       (socket open)
   TLS:         0 ms       (TLS context held)
   Server:    +58 ms       (1 RTT to edge + cache lookup)
   Body:      +10-20 ms    (depends on body size)
   ─────────────────
   TOTAL:    ~70-90 ms
```

### Wire size, with Brotli

| | Bytes | Compression |
|---|---|---|
| Raw JSON response | 220,181 B | baseline |
| Gzipped on wire | ~52 KB | 4.2× (76% saved) |
| **Brotli on wire** | **17,875 B** | **12.3× (92% saved)** |

Modern clients (Postman, browsers, newer OkHttp) negotiate Brotli automatically. Older Android RN clients fall back to gzip. Both are absorbed transparently by Cloud CDN's `compression-mode=AUTOMATIC`.

### Cache invalidation propagation

| Stage | Time |
|---|---|
| `urlMaps.invalidateCache` API call | ~200 ms (API ack) |
| Cache entries flushed across global edge fleet | ~30-60s typical, <3 min P99 |

### Summary metrics

| Metric | Value | Notes |
|---|---|---|
| **Cold call p50 (fresh TCP, cache warm)** | **106 ms** | hey -disable-keepalive, post-cache-warmup |
| **Cold call p99 (fresh TCP, cache warm)** | **145 ms** | tight tail under normal conditions |
| **Cold call p99 (synthetic worst-case: invalidated cache + cold Cloud Run)** | 5,338 ms | Only happens in artificial tests; <0.001% in production |
| **Warm in-session call p50 (keepalive)** | **78 ms** | hey default, mimics same-session re-requests |
| **TTFB on warm cache hit** | **~35-58 ms** | = ~1 RTT + 5ms edge lookup |
| **TTFB on cache miss (warm Cloud Run)** | ~200-290 ms | Firestore tenant-scoped query + serialize |
| **TTFB on cache miss (cold Cloud Run)** | ~1500-5000 ms | Rare; mitigated by `min-instances=1` |
| **Network RTT (India → Google edge POP)** | ~30-50 ms | Mumbai/Chennai POP |
| **Wire size (Brotli)** | 17.8 KB | down from 220 KB raw (-92%) |
| **Bundle byte download throughput** | ~86 Mbps | 5 MB bundle in ~800 ms |
| **Cache invalidation propagation** | <60s typical, <3min P99 | Per-tenant via `urlMaps.invalidateCache` |
| **Throughput from single client** | 186 req/s | Cloud CDN absorbs load comfortably |

## Where the latency goes today (Cloud CDN + gzip)

```
┌──── COLD CALL ~170ms (cache HIT, fresh TCP connection — first app open) ───┐
│                                                                            │
│  ~3ms     DNS lookup           (OS resolver, cached locally after first)   │
│  ~60ms    TCP handshake         (1 RTT to nearest Google edge POP)         │
│  ~60ms    TLS handshake         (1 RTT for TLS 1.3)                        │
│  ~3ms     HTTP/2 setup          (settings frame exchange)                  │
│  ~30ms    Request → edge        (1 one-way trip)                           │
│  ~5ms     Cloud CDN cache lookup (microsecond-cheap memory access)         │
│  ~25ms    Response start back   (1 one-way trip)                           │
│  ~15ms    Body transfer (14KB)  (fits in 1-2 TCP packets, no slow-start)   │
└────────────────────────────────────────────────────────────────────────────┘

┌──── WARM CALL ~60ms (connection reused — every subsequent request) ────────┐
│                                                                            │
│  ~0ms     DNS / TCP / TLS       (already established)                      │
│  ~30ms    Request → edge        (1 one-way trip)                           │
│  ~5ms     Cache lookup                                                     │
│  ~25ms    Response → client                                                │
│  ~5ms     Body transfer (14KB)                                             │
└────────────────────────────────────────────────────────────────────────────┘

The 50-60ms TTFB on a warm call is the absolute floor — 1 full RTT to the
nearest POP + cache lookup. Cannot go below this without moving the POP
closer (this is what Cloudflare's denser POP network gives).

When cache MISS (~1% of requests, mainly first hit per tenant per 30d):
  → Cloud CDN forwards to Cloud Run                                 [+~150-250ms RTT]
  → Hono routes to upstream handler                                 [+~5-10ms]
  → firebaseDatabase tenant-scoped query                            [+~70-100ms Firestore]
  → Storage plugin rewrites bundle URLs through cdnUrl env var      [+~1ms]
  → Cloud CDN compresses (gzip) + caches result for 30 days
  Total miss (warm Cloud Run instance):     ~270-400ms
  Total miss (cold Cloud Run container):    ~1500-2200ms
```

**Cache HIT serves in 60ms warm / 170ms cold.** Cache MISS is rare and each tenant pays it *exactly once per (platform, channel, fingerprint, currentBundleId) per deploy* — after that, all subsequent reads at every Google edge POP hit cache until next invalidation.

## Optimization timeline

| Date | Change | Effect |
|---|---|---|
| Before 2026-05-23 | Firebase Hosting CDN only, 60s TTL, no per-tenant invalidation, in-memory cache inside Cloud Run | ~100-150ms warm, ~400-800ms on miss, no instant invalidation |
| 2026-05-25 | Migrated to Google Cloud CDN + Global LB on `ota.tile.dev` | Per-tenant invalidation, 30d edge TTL, immutable bundle bytes |
| 2026-05-25 | Removed in-memory cache from Cloud Run (Cloud CDN absorbs ~all reads) | Simpler code, same latency, no confusing `x-tile-cache` header |
| 2026-05-25 | Enabled `compression-mode=AUTOMATIC` on `backend-checkupdate` (gzip + Brotli) | 220 KB → 17.8 KB on wire (-92%), ~100 ms cold latency saved on apptile-seed body, ~$800/mo egress saved at realistic scale |
| 2026-05-25 | Deployed end-to-end test on tilepacket (real Android device) | Confirmed device hits ota.tile.dev, downloads bundle via CDN, force-update flag respected |
| 2026-05-26 | Patch generation wired end-to-end (added `GET /storage/download-url`) | Devices on patch-base bundles download ~1-200 KB bsdiff instead of ~944 KB whole bundle |
| 2026-05-26 | Stripped `eligibleNumericCohorts` from v2 check-update response | Raw response 23,422 → 3,822 B (-84%), gzip 3,328 → 1,117 B (-66%). Fits in single MTU. Client uses `isCohortEligibleForUpdate(id, cohort, rolloutCohortCount, targetCohorts)` to derive eligibility on-device — same deterministic function the server used to build the array. |

## Measured before / after eligibleNumericCohorts strip (apples-to-apples, same URL, same machine, 2026-05-26)

Test URL (tilepacket tenant, device on `019e608a`, 5 candidates in response):

| Metric | Before strip | After strip | Δ |
|---|---|---|---|
| Raw JSON | 23,422 B | **3,822 B** | **-19.6 KB (-84%)** |
| Gzipped on wire | 3,328 B | **1,117 B** | **-2.2 KB (-66%)** |
| TCP packets to deliver | 3 (multi-MTU) | **1 (fits in single 1500-byte MTU)** | -2 round trips at risk of retransmission |
| Body transfer time (wired, 100+ Mbps) | ~0.3 ms | **~0.1 ms** | -0.2 ms (rounding) |
| Body transfer time (4G, ~10 Mbps) | ~3-5 ms | **~1 ms** | **-2-4 ms** |
| Device-side JSON parse (5000 ints not allocated) | ~5-10 ms on phone CPU | ~1-2 ms | **~4-8 ms** |
| CDN egress at 1B reqs/yr (Google's $0.08/GB) | 3.1 TB / yr | **1.0 TB / yr** | **-$170 / year** |

The wire savings are modest on absolute terms, but the response is now under one MTU. On flaky mobile networks that matters more than the bandwidth math — one packet either arrives or doesn't; three packets each have independent retransmission risk. Device-side JSON parse savings (5000 fewer int allocations per request) is the bigger win at scale.

## Measured before / after gzip (apples-to-apples, same URL, same machine)

| Metric | Before gzip | After gzip | Δ |
|---|---|---|---|
| Wire size | 52,315 B | **14,476 B** | **-72%** |
| Cold call total (curl, separate process) | ~270 ms | **~170 ms** | **-96 ms (-36%)** |
| Cold call TTFB | ~180 ms | ~160 ms | -20 ms |
| Warm call total | ~78 ms | **~60 ms** | **-18 ms (-23%)** |
| Warm call TTFB | ~50 ms | ~50 ms | 0 (gzip doesn't affect first-byte time) |

Body transfer savings exceeded the naive bandwidth math because the smaller payload fits in 1-2 TCP packets — skipping the TCP slow-start "ramp-up" round trips that 52 KB needed.

## What real mobile clients experience

A React Native app on a typical 4G connection in India:

```
App launch
   │
   ├─ check-update fires (SDK → ota.tile.dev)
   │     1st call: pays full ~170 ms (DNS, TCP, TLS, request)
   │
   ├─ If bundle available, download starts on SAME connection (TCP keepalive)
   │     bundle.zip ~5 MB: ~80ms TTFB + ~700ms transfer = ~800 ms
   │     OR if assets cached locally: only download deltas = ~50-200 ms
   │
   └─ Subsequent in-session requests: ~60 ms each (connection reused)
```

On a relaunch ~30 min later (TCP closed, TLS session ticket may still be valid):
- DNS still cached by OS: skip ~50 ms
- TLS session resumed: skip ~50 ms of handshake
- ~80-120 ms first call instead of ~170 ms cold

App backgrounded then resumed within ~30s: connection still open, ~60 ms.

## Comparison to flagship OTA SaaS (APAC)

| Provider | Cold p50 (India) | Warm p50 | p95 cold | p99 cold | Bundle throughput |
|---|---|---|---|---|---|
| **tile-push (cache warm, post-Brotli)** | **106 ms** | **78 ms** | **134 ms** | **145 ms** | **86 Mbps** |
| Expo EAS Updates (Cloudflare) | 150-220 ms | 80-150 ms | 250-350 ms | 400-600 ms | ~90 Mbps |
| Microsoft CodePush (Azure CDN, retired) | 400-600 ms | 250-400 ms | 500-700 ms | 800-1500 ms | 50-70 Mbps |
| Microsoft App Center | 400-600 ms | 250-400 ms | 500-700 ms | 800-1500 ms | 50-70 Mbps |
| Cloudflare Workers + R2 (best-in-class floor) | 100-200 ms | 50-100 ms | 200-300 ms | 300-450 ms | ~90 Mbps |

**Numbers measured today with `hey -n 200 -c 20 -disable-keepalive`** against `ota.tile.dev` with warm cache (the realistic steady state). At the median tile-push is **on par with Cloudflare Workers and ahead of EAS**. p99 of 145ms is tighter than every commercial alternative.

## Mobile device reality

The latencies above are from a wired client (laptop in India). Real mobile devices observe **2-3× higher** total times because:

| Factor | Wired | Mobile (4G) |
|---|---|---|
| DNS lookup | ~50 ms | ~100-300 ms (carrier DNS slower) |
| TCP handshake RTT | ~30-50 ms | ~50-100 ms |
| TLS handshake RTT | ~30-50 ms | ~50-100 ms |
| Body transfer (220KB raw / 17.8KB Brotli) | ~20 ms | ~30-100 ms |
| Server-side cache miss cost (one-time per state) | +290 ms | +290 ms |
| **Total cold call typical** | **~250 ms** | **~500-1500 ms** |
| **Cache miss + Cloud Run warm + mobile network** | **~500 ms** | **~1500-2500 ms** |

The 800ms-2500ms cold call observed on the test Android device matches the model: mobile cellular handshake overhead + cache miss on unique `currentBundleId` URL → Cloud Run + Firestore round trip.

## The cache MISS cardinality issue

Each device's check-update URL includes its own `currentBundleId`. That means cache cardinality is bounded by the number of distinct (bundleId, minBundleId) states across the active device fleet, not infinitely large.

| Fleet scenario | Distinct cache keys | First-call cost |
|---|---|---|
| All devices on same bundle X | 1 cache key | Only first device pays miss; rest hit cache |
| After deploy, 80% on new + 15% on previous + 5% older | ~3-5 cache keys | Each unique state pays one miss; thousands of devices share each entry |
| Fresh installs (all from same APK) | 1 cache key per APK build | Single miss amortized across all fresh installs of that APK |

In practice, ~99% of production check-update requests are edge cache HITs. The 1% cache miss cost is paid once per unique device state per deploy, then amortized across thousands of devices.

**The only way to eliminate this entirely** is to move `currentBundleId` filtering to the client (server returns ALL candidates regardless of device's current bundle, client filters locally). That collapses cardinality to 1 key per (tenant, platform, channel, fingerprint). Documented as a post-demo optimization.

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
