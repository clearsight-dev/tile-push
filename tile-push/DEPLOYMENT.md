# tile-push Deployment Guide

Step-by-step instructions for deploying the `tile-push` Cloud Function + Firestore indexes to GCP. Assumes you're starting from a fresh clone of this repo and have GCP project access.

## Prerequisites

You need:
- Node.js 22 (the function runtime), `pnpm` (the workspace package manager), and `npm` (used at deploy time)
- `firebase` CLI (firebase-tools)
- `gcloud` CLI
- Access to the GCP project `apptile-staging-setup` (or whichever project you're deploying to)

Install CLIs:

```bash
# pnpm
npm install -g pnpm

# Firebase CLI
npm install -g firebase-tools

# gcloud (macOS via Homebrew)
brew install --cask google-cloud-sdk
```

Authenticate (one-time setup):

```bash
firebase login
gcloud auth login
gcloud auth application-default login   # so Firebase Admin SDK works locally if needed
```

## One-time GCP setup (skip if the project is already configured)

These steps are idempotent. Safe to re-run.

### 1. Set the active project

```bash
gcloud config set project apptile-staging-setup
```

### 2. Enable required APIs

```bash
gcloud services enable \
    cloudfunctions.googleapis.com \
    cloudbuild.googleapis.com \
    firestore.googleapis.com \
    firebasestorage.googleapis.com \
    artifactregistry.googleapis.com \
    compute.googleapis.com \
    run.googleapis.com \
    eventarc.googleapis.com \
    pubsub.googleapis.com \
    firebaseextensions.googleapis.com
```

### 3. Add Firebase to the GCP project (if not already)

```bash
firebase projects:list | grep apptile-staging-setup
# If empty, run:
firebase projects:addfirebase apptile-staging-setup
```

### 4. Create the named Firestore database

```bash
gcloud firestore databases list | grep tile-push
# If missing, run:
gcloud firestore databases create \
    --database=tile-push \
    --location=us-central1 \
    --type=firestore-native
```

> **Important:** This is a *named* database, NOT `(default)`. The fork's firebaseDatabase.ts is wired to talk to this specific name.

### 5. Create the bundle storage bucket

```bash
gcloud storage buckets describe gs://tile-push-bundles 2>/dev/null
# If missing, run:
gcloud storage buckets create gs://tile-push-bundles \
    --location=us-central1 \
    --uniform-bucket-level-access
```

## Build the firebase plugin

From the repo root:

```bash
# Install workspace dependencies (only needed once or when package.json changes)
pnpm install

# Build the firebase plugin (and its monorepo dependencies via nx)
pnpm nx build @hot-updater/firebase
```

Build output goes to `plugins/firebase/dist/firebase/`:

```
plugins/firebase/dist/firebase/
├── functions/
│   └── index.cjs              # bundled Cloud Function (~325 KB)
└── public/
    ├── firebase.json          # deploy config
    ├── .firebaserc            # project alias
    ├── firestore.indexes.json # composite indexes
    └── functions/
        └── _package.json      # runtime deps template
```

## Assemble the deploy directory

Firebase CLI expects a specific directory layout. The build output is split between `functions/` and `public/`; we need to assemble them into one flat deploy directory.

```bash
DEPLOY=plugins/firebase/deploy
rm -rf "$DEPLOY" && mkdir -p "$DEPLOY/functions"

cp plugins/firebase/dist/firebase/public/firebase.json          "$DEPLOY/"
cp plugins/firebase/dist/firebase/public/.firebaserc            "$DEPLOY/"
cp plugins/firebase/dist/firebase/public/firestore.indexes.json "$DEPLOY/"
cp plugins/firebase/dist/firebase/functions/index.cjs           "$DEPLOY/functions/"
cp plugins/firebase/dist/firebase/public/functions/_package.json "$DEPLOY/functions/package.json"
```

After this, the deploy directory looks like:

```
plugins/firebase/deploy/
├── firebase.json
├── .firebaserc
├── firestore.indexes.json
└── functions/
    ├── index.cjs
    └── package.json
```

> **The `deploy/` directory is gitignored** — it's regenerated on every build/deploy cycle.

## Install runtime deps locally

The Firebase CLI introspects your function (calls `require()` on `index.cjs`) at deploy time to discover exports. This requires `firebase-functions` and `firebase-admin` to be resolvable on disk.

```bash
cd plugins/firebase/deploy/functions
npm install
cd -
```

This creates `plugins/firebase/deploy/functions/node_modules/` with the two declared deps. Takes ~30 seconds.

## Deploy

From the deploy directory:

```bash
cd plugins/firebase/deploy
firebase deploy \
    --only functions:tile-push,firestore:indexes,hosting \
    --project apptile-staging-setup \
    --non-interactive \
    --force
```

Expected duration: 3-5 minutes.

**Always include `hosting` in `--only` when you re-deploy functions.** See [pinTag gotcha](#-pintag-gotcha--always-redeploy-hosting-alongside-functions) below.

What this deploys:
- **Firestore indexes** for `bundles` collection on the `tile-push` named database (NOT `(default)`)
- **Cloud Function** `tile-push` (Gen 2) in us-central1, listening at `https://tile-push-<hash>-uc.a.run.app`
- **Hosting** rewrites + cache rules + Cache-Control header injection for `/api/check-update/v2/**`

## ⚠ pinTag gotcha — always redeploy Hosting alongside functions

`plugins/firebase/firebase/public/firebase.json` sets `pinTag: true` on the Hosting rewrite to the Cloud Function:

```json
{
  "hosting": {
    "rewrites": [{
      "source": "/api/**",
      "function": { "functionId": "tile-push", "region": "us-central1", "pinTag": true }
    }]
  }
}
```

This pins Hosting traffic to a **specific Cloud Run revision tag**. Useful for blue-green deploys, but has a sharp edge:

**If you deploy ONLY the function, Hosting won't see the new code.** A new Cloud Run revision is created but Hosting keeps routing to whichever revision the pin was set to last.

| Command | Function deployed | Hosting pin refreshed | Result |
|---|---|---|---|
| `firebase deploy --only functions:tile-push` | Yes | **No** | New code exists but Hosting serves old revision |
| `firebase deploy --only hosting` | No | Yes (to old revision) | Same as before |
| `firebase deploy --only functions:tile-push,hosting` | Yes | **Yes** (to new revision) | ✓ correct |
| `firebase deploy` (no `--only`) | Yes | Yes | ✓ correct, deploys everything |

**Rule of thumb**: when redeploying the function, **always** include hosting in `--only` (or omit `--only` entirely).

How to tell you've been bitten by this:
- `curl https://tile-push-io7lmh2oqa-uc.a.run.app/api/check-update/v2/...` returns NEW response shape ✓
- `curl https://apptile-staging-setup.web.app/api/check-update/v2/...` returns OLD response shape ✗
- Direct origin works, Hosting doesn't → pin wasn't refreshed → run `firebase deploy --only hosting` to fix

How to verify the pin is fresh after deploy:
```bash
# Both URLs should return the same response shape:
curl -sS "https://tile-push-io7lmh2oqa-uc.a.run.app/api/check-update/v2/t/tk_test/fingerprint/android/test/production/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['candidates']))"
curl -sS "https://apptile-staging-setup.web.app/api/check-update/v2/t/tk_test/fingerprint/android/test/production/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['candidates']))"
# Counts should match.
```

If counts differ, Hosting still has the old pin. Force a re-pin:
```bash
firebase deploy --only hosting --project apptile-staging-setup
```

Look for these lines in the output (success indicators):
```
✔  firestore: deployed indexes in firestore.indexes.json successfully for tile-push database
✔  functions: functions source uploaded successfully
✔  functions[tile-push(us-central1)] Successful update operation.
Function URL (tile-push(us-central1)): https://tile-push-<hash>-uc.a.run.app
```

## Grant public access (one-time after first deploy)

Cloud Functions Gen 2 require explicit unauthenticated invocation. Without this, requests return 403 Forbidden.

```bash
gcloud run services add-iam-policy-binding tile-push \
    --region=us-central1 \
    --member=allUsers \
    --role=roles/run.invoker \
    --project=apptile-staging-setup
```

This is a **one-time setup**. Subsequent deploys preserve the IAM policy.

## Smoke test

Replace the URL hash with what you got from your deploy output.

```bash
URL="https://tile-push-io7lmh2oqa-uc.a.run.app"

# Version endpoint — should return JSON
curl -sS "$URL/api/check-update/version"
# Expect: {"version":"0.31.4"}

# Ping
curl -sS "$URL/ping"
# Expect: pong

# Fingerprint update check (no bundles deployed = null)
curl -sS "$URL/api/check-update/fingerprint/ios/test-fp/production/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000/427"
# Expect: null  (no bundles available for this fingerprint)
```

If all three respond correctly, your deploy is healthy.

## Common failures and fixes

### "Failed to find location of Firebase Functions SDK"

You skipped the `npm install` step in `deploy/functions/`. The Firebase CLI needs `firebase-functions` resolvable on your local disk to introspect the function. Run:
```bash
cd plugins/firebase/deploy/functions && npm install && cd -
```

### "Container Healthcheck failed... port 8080"

The function container started but crashed before binding to port 8080. Fetch logs to see why:
```bash
gcloud logging read \
    "resource.type=cloud_run_revision AND resource.labels.service_name=tile-push" \
    --limit=20 --format="value(textPayload)" \
    --project=apptile-staging-setup
```

Common causes:
- **"Cannot find module '@hot-updater/server/runtime'"** — A workspace package is left as external in the bundle instead of being inlined. Add it to `alwaysBundle` in `plugins/firebase/tsdown.config.ts`, rebuild, redeploy.
- **"HotUpdater is not defined"** — The original upstream code uses `HotUpdater.REGION` substitution. Our fork hardcodes `REGION = "us-central1"` in `plugins/firebase/firebase/functions/index.ts`. If you see this error, you've reverted that change.

### "403 Forbidden" on every request

You skipped the IAM step. Run:
```bash
gcloud run services add-iam-policy-binding tile-push \
    --region=us-central1 --member=allUsers --role=roles/run.invoker \
    --project=apptile-staging-setup
```

### "Firestore: NOT_FOUND" errors at runtime

The `tile-push` named Firestore database doesn't exist. Verify with `gcloud firestore databases list` and create it (see step 4 of one-time setup).

### "Bucket not found" errors

`tile-push-bundles` bucket doesn't exist. Create per step 5 of one-time setup.

## Rollback

If a deploy is bad:

```bash
# List recent revisions of the Cloud Run service
gcloud run revisions list --service=tile-push --region=us-central1 \
    --project=apptile-staging-setup

# Route all traffic back to a previous good revision
gcloud run services update-traffic tile-push \
    --to-revisions=tile-push-00001-xxx=100 \
    --region=us-central1 \
    --project=apptile-staging-setup
```

Replace `tile-push-00001-xxx` with the previous good revision name.

## Deploying just the function (skip Firestore index changes)

If you didn't touch `firestore.indexes.json`:
```bash
firebase deploy --only functions:tile-push --project apptile-staging-setup
```

This avoids the (idempotent but slow) Firestore indexes deployment.

## Deploying just Firestore indexes (no code change)

```bash
firebase deploy --only firestore:indexes --project apptile-staging-setup
```

Useful when adding a new composite index.

## Tearing down (only if you really mean to)

```bash
# Delete the Cloud Function
gcloud functions delete tile-push --region=us-central1 --project=apptile-staging-setup

# Delete the Firestore database (DESTRUCTIVE — confirms required)
gcloud firestore databases delete tile-push --project=apptile-staging-setup

# Delete the storage bucket (must be empty)
gcloud storage rm --recursive gs://tile-push-bundles
```

## What this deploys vs what it doesn't

| Touched | Untouched |
|---|---|
| Firestore database `tile-push` | Firestore databases `apptile`, `devappconfigresolver-db`, etc. |
| Cloud Function `tile-push` | Any other Cloud Functions in the project |
| Storage bucket `tile-push-bundles` | All other buckets in the project |
| IAM bindings on `tile-push` service | Project-level IAM, other services |

The fork was carefully scoped to only touch resources prefixed with `tile-push-` (or named `tile-push`). Re-deploying never affects unrelated workloads in the shared `apptile-staging-setup` project.
