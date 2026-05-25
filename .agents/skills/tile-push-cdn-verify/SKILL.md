---
name: tile-push-cdn-verify
description: Use when tile-push CDN or Cloud Run code has just been changed and we need to confirm the live infrastructure still behaves correctly. Runs a 5-point health check against both ota.tile.dev (Cloud CDN) and the Firebase Hosting fallback URL — Cache-Control headers, bundle URL transformation, immutable cache on bytes, admin no-store, invalidation log. Use after any deploy that touches headers, invalidation, cdnUrl, or upload signed URLs.
---

# Tile Push — CDN Health Check

5-point regression test that confirms the production CDN setup is intact after any change. Treats both `https://ota.tile.dev` (primary, Cloud CDN) and `https://apptile-staging-setup.web.app` (fallback, Firebase Hosting) as equally valid endpoints — they should return the same data.

## When to use

- Immediately after running the `tile-push-deploy` skill, to confirm nothing regressed.
- When investigating "why doesn't my device see the new bundle" — these checks isolate the layer (origin / CDN / cache / SDK URL).
- When verifying a fresh tenant's setup (the candidates response check validates Firestore + storage are wired up).
- Whenever ARCHITECTURE.md or GCP_INFRASTRUCTURE.md is updated — to confirm the doc matches reality.

## Workflow

Run all 5 checks. Each check is independent; a failure in one doesn't invalidate the others. Report which passed and which failed, with the actual response if a failure.

### Check 1 — `/api/check-update/*` has cacheable Cache-Control

```bash
curl -sI https://ota.tile.dev/api/check-update/version | grep -iE "cache-control|^http"
```

Expected:
```
HTTP/2 200
cache-control: public, max-age=60, s-maxage=2592000
```

What this proves: `index.ts` sets the right header on check-update responses, AND the LB forwards it through. If `s-maxage` is missing or different → code regression in [`plugins/firebase/firebase/functions/index.ts`](../../../plugins/firebase/firebase/functions/index.ts) `runOnce` branch.

If `ota.tile.dev` returns SSL handshake error, fall back to the Firebase Hosting URL — same code, same headers:
```bash
curl -sI https://apptile-staging-setup.web.app/api/check-update/version | grep -iE "cache-control"
```

### Check 2 — `/api/cli/*` is uncacheable (no-store + Vary: Authorization)

```bash
curl -sI https://ota.tile.dev/api/cli/t/tk_apptile-seed/me | grep -iE "cache-control|vary|^http"
```

Expected:
```
HTTP/2 401
cache-control: private, no-store
vary: Authorization, ...
```

The 401 is correct — we didn't send a token. We're checking that the response is uncacheable, not that auth works. What this proves: CLI/admin endpoints route to `backend-admin` (Cloud CDN OFF) and the code sets defensive `no-store` + `Vary: Authorization`.

If you see `cache-control: public, max-age=...` here → security bug, admin response would be CDN-cached. Stop and investigate.

### Check 3 — Bundle URLs in candidates response use `ota.tile.dev`

You need a real fingerprint hash to query. The apptile-seed Android fingerprint is in [`/Users/yaswantha/apptile-seed/fingerprint.json`](../../../apptile-seed/fingerprint.json) under `android.hash`.

```bash
ANDROID_FP=$(python3 -c 'import json; print(json.load(open("/Users/yaswantha/apptile-seed/fingerprint.json"))["android"]["hash"])')
curl -s "https://ota.tile.dev/api/check-update/v2/t/tk_apptile-seed/fingerprint/android/$ANDROID_FP/production/0/0" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for c in data.get("candidates", []):
    print(f"  bundle.zip: {c.get(\"fileUrl\")}")
    for asset_key, asset in (c.get("changedAssets") or {}).items():
        print(f"  asset {asset_key}: {asset[\"file\"][\"url\"]}")
    break  # only first candidate
'
```

Expected: all URLs start with `https://ota.tile.dev/t/tk_apptile-seed/`.

If URLs start with `https://storage.googleapis.com/...` → `HOT_UPDATER_CDN_URL` env var on Cloud Run isn't `https://ota.tile.dev`. Either the env var was lost on the last deploy, OR the code default in [`index.ts`](../../../plugins/firebase/firebase/functions/index.ts) (line ~26) doesn't match.

### Check 4 — Bundle bytes have immutable Cache-Control

Pick any existing bundle and check its metadata directly from GCS:

```bash
SOMEBUNDLE=$(gcloud storage ls gs://tile-push-bundles/t/tk_apptile-seed/ 2>/dev/null | head -1 | awk -F'/' '{print $(NF-1)}')
gcloud storage objects describe "gs://tile-push-bundles/t/tk_apptile-seed/$SOMEBUNDLE/bundle.zip" \
  --format="value(cacheControl)"
```

Expected: `public, max-age=31536000, immutable`

If empty or different → either the upload signed URL handler in [`cliRoutes.ts`](../../../plugins/firebase/firebase/functions/cliRoutes.ts) isn't setting `Cache-Control`, OR an existing object has stale metadata. Bulk-fix existing objects with:
```bash
gcloud storage objects update "gs://tile-push-bundles/**" \
  --cache-control="public, max-age=31536000, immutable"
```
(takes a minute, patches all bundle objects in place)

### Check 5 — CDN invalidation fires on deploy

This one requires a recent deploy to have happened. Check Cloud Run logs:

```bash
gcloud logging read 'resource.type=cloud_run_revision AND textPayload:"[cdn] invalidated"' \
  --limit=5 --format="value(timestamp,textPayload)"
```

Expected (after any deploy in the last hour):
```
2026-05-25T...  [cdn] invalidated /api/check-update/v2/t/tk_apptile-seed/* op=operation-... status=PENDING
```

If no recent log line → either no deploy has happened since the invalidation code shipped, OR `invalidateTenantCache` in [`cliRoutes.ts`](../../../plugins/firebase/firebase/functions/cliRoutes.ts) is failing silently. The function logs errors with `[cdn] invalidation failed for ...:` — search for that too:
```bash
gcloud logging read 'resource.type=cloud_run_revision AND textPayload:"[cdn] invalidation"' \
  --limit=10 --format="value(timestamp,textPayload)"
```

### After all 5 checks

Report results in a compact table:

```
1. check-update Cache-Control          ✅ s-maxage=2592000
2. /api/cli/* no-store                  ✅
3. Bundle URLs use ota.tile.dev         ✅
4. Bundle bytes immutable               ✅
5. CDN invalidation on deploy           ✅ last fired 2 min ago
```

If any fail, fix before claiming the deploy is healthy.

## Quick reference: production endpoints

| Endpoint | URL | Cache behavior |
|---|---|---|
| Primary check-update | `https://ota.tile.dev/api/check-update/...` | 30d edge, invalidated on deploy |
| Primary bundle bytes | `https://ota.tile.dev/t/{appId}/{bundleId}/...` | 1y immutable |
| Primary admin/CLI | `https://ota.tile.dev/api/cli/...` | never cached |
| Fallback (Hosting) | `https://apptile-staging-setup.web.app/api/...` | 60s edge |
| Direct origin | `https://tile-push-io7lmh2oqa-uc.a.run.app` | n/a (origin) |

## Do not

- Don't skip checks 3-5 just because 1-2 pass. The most common regression mode is "headers look right but cdnUrl env var got dropped" — only Check 3 catches that.
- Don't run these checks against the direct Cloud Run URL (`*.a.run.app`) — that bypasses LB + CDN and tells you nothing about the production path customers hit.
- Don't trust the result if `ota.tile.dev` returns SSL handshake errors — the cert provisioner might have hit a glitch. Verify on the Hosting fallback first, then dig into cert status: `gcloud compute ssl-certificates describe tile-push-cert-v2 --global --format="value(managed.status,managed.domainStatus)"`.
