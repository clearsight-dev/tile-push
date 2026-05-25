---
name: tile-push-deploy
description: Use when changes are made to the tile-push firebase function code (anything under plugins/firebase/firebase/functions/ or plugins/firebase/src/) and the changes need to land on the live Cloud Run service. Walks through the build → sync → firebase deploy chain plus post-deploy verification. Also use after editing Cache-Control headers, the cliRoutes invalidation hook, or the firebaseFunctionsStorage CDN URL transform.
---

# Tile Push — Deploy Firebase Function

This skill ships code changes from the source tree to the live `tile-push` Cloud Run service in GCP project `apptile-staging-setup`. The deploy is **not just `firebase deploy`** — there's an intermediate `dist/` → `deploy/` sync step that's easy to miss.

## When to use

- You edited [`plugins/firebase/firebase/functions/index.ts`](../../../plugins/firebase/firebase/functions/index.ts), [`cliRoutes.ts`](../../../plugins/firebase/firebase/functions/cliRoutes.ts), or [`cliAuth.ts`](../../../plugins/firebase/firebase/functions/cliAuth.ts).
- You edited any file under [`plugins/firebase/src/`](../../../plugins/firebase/src/) (storage / database plugins).
- You updated an env var defaulting in code that needs to take effect on the live function.
- You need to add a new Firestore composite index (the `--only functions,firestore:indexes` deploy includes them).

## When NOT to use

- SDK changes only (`@tile-push/react-native` or `@tile-push/cli`). Those don't need a function deploy.
- Read-only config changes in GCP Console (env vars, IAM). Those apply directly without a deploy.
- Firestore data changes (use the CLI's bundle commands or Firestore Console).

## Workflow

### 1. Sanity check what you're about to ship

```bash
cd /Users/yaswantha/hot-updater   # repo root, adjust if cloned elsewhere
git status --short plugins/firebase/
```

Confirm only the intended files have diffs. If unrelated files appear, sort them out first — they'll all ship in this deploy.

### 2. Build the firebase plugin

```bash
cd plugins/firebase
pnpm build
```

Expected output ends with `✔ Build complete`. The build emits `dist/firebase/functions/index.cjs` (~350 KB single CJS bundle). If `--failOnWarn` errors out, fix the warning before continuing — silently exporting broken code is not OK.

### 3. Sync built bundle into deploy directory

The repo separates `dist/` (build output) from `deploy/` (what firebase actually ships). Sync the bundle:

```bash
cp dist/firebase/functions/index.cjs deploy/functions/index.cjs
```

Other files in `deploy/` (firebase.json, .firebaserc, firestore.indexes.json, functions/package.json, functions/node_modules/) stay as-is — they were synced during the first time deploy/ was set up. See [`tile-push/DEPLOYMENT.md`](../../../tile-push/DEPLOYMENT.md) for full deploy-folder origin info.

### 4. Deploy

```bash
cd deploy
firebase deploy --only functions,hosting --project=apptile-staging-setup
```

**Why include `hosting`?** Firebase Hosting has `pinTag: true` rewrites pinning to the function's current Cloud Run revision. If you deploy functions without hosting, the Hosting rewrite still points at the OLD revision → fallback URL serves stale code. Always include both.

Add `firestore:indexes` if you changed `firestore.indexes.json`:
```bash
firebase deploy --only functions,hosting,firestore:indexes --project=apptile-staging-setup
```

Expected output ends with `✔ Deploy complete!` and shows the function URL `https://tile-push-io7lmh2oqa-uc.a.run.app`.

### 5. Verify the new code is live

Pick whichever applies based on what you changed:

```bash
# A. New Cache-Control behavior or check-update logic
curl -sI https://apptile-staging-setup.web.app/api/check-update/version | head -10
# Look for: HTTP/2 200, Cache-Control matching what you wrote in code

# B. CLI admin endpoints
curl -sI https://apptile-staging-setup.web.app/api/cli/t/tk_apptile-seed/me | head -5
# Look for: HTTP/2 401, Cache-Control: private, no-store

# C. Cache invalidation hook (only verifiable after a real CLI deploy fires it)
gcloud logging read 'resource.type=cloud_run_revision AND textPayload:"[cdn] invalidated"' --limit=3
# Should show recent invalidation log lines if any deploys happened post-change
```

If you also want to verify via the Cloud CDN host:

```bash
curl -sI https://ota.tile.dev/api/check-update/version
# Same as the Hosting URL — should return cache-control header set by code
```

### 6. If something looks wrong

- **`firebase deploy` fails:** Read the error. Common causes: stale node_modules in `deploy/functions/` (re-run `npm install` there), wrong firebase project (`firebase use apptile-staging-setup`), missing IAM (need `roles/firebase.admin` or finer).
- **Function deployed but old behavior:** Browser/curl might be hitting cached responses. Try with `Cache-Control: no-cache` header or wait 60s.
- **Cloud Run revision is stuck:** `gcloud run revisions list --service=tile-push --region=us-central1` shows revisions; `gcloud run services update-traffic tile-push --to-latest --region=us-central1` forces traffic to newest.

## Quick reference: critical resource names

These are the GCP entities a deploy touches. Full inventory is in [`tile-push/GCP_INFRASTRUCTURE.md`](../../../tile-push/GCP_INFRASTRUCTURE.md).

| Resource | Name |
|---|---|
| GCP project | `apptile-staging-setup` |
| Cloud Run service | `tile-push` |
| Region | `us-central1` |
| Firestore DB (named) | `tile-push` |
| GCS bucket | `tile-push-bundles` |
| LB URL map | `tile-push-lb` |
| CDN-cacheable backend | `backend-checkupdate` |
| Non-cacheable backend | `backend-admin` |
| Backend bucket for bytes | `backend-bundles` |
| Customer SDK baseURL | `https://ota.tile.dev` |
| Fallback URL (Hosting) | `https://apptile-staging-setup.web.app` |

## Do not

- Don't modify `deploy/functions/index.cjs` by hand — it's a build artifact, the next build will clobber it.
- Don't deploy without first running `pnpm build`. The bundle in `deploy/` becomes stale relative to source.
- Don't deploy from `dist/` directly — `firebase` needs the assembled `deploy/` directory with the right `package.json` (declares only `firebase-admin` + `firebase-functions` as runtime deps).
- Don't skip the `hosting` deploy. The pinTag rewrite needs to be refreshed every time.
- Don't run `firebase use` to switch projects without explicit user confirmation. Wrong project = wrong tenant data.
