# tile-push (CLAUDE.md)

This file is the agent-readable summary of this fork. Read this first when working on tile-push tasks.

## What this is

`tile-push` is a fork of [hot-updater](https://github.com/gronxb/hot-updater) (MIT) being shaped into a **multi-tenant OTA-as-a-Service** product. The fork lives at https://github.com/clearsight-dev/tile-push.

Current state: **single-tenant MVP deployed**. Multi-tenancy is planned but not implemented. The data model has a placeholder `appId` field that no queries currently filter by.

## Current production setup

| | |
|---|---|
| GCP project | `apptile-staging-setup` (project number `1097788179850`) |
| Region | `us-central1` |
| Cloud Function name | `tile-push` (Gen 2, runs on Cloud Run) |
| Function URL | `https://tile-push-io7lmh2oqa-uc.a.run.app` |
| Firestore database | `tile-push` (named DB, not `(default)`) |
| Storage bucket | `tile-push-bundles` (in same project, us-central1) |
| Deploys via | `firebase deploy` from `plugins/firebase/deploy/` |

## Diff from upstream (what we changed)

Five focused changes. See `ARCHITECTURE.md` for full details.

1. **[packages/core/src/types.ts](../packages/core/src/types.ts)** — added `appId?: string` to `Bundle` interface (no queries use it yet)
2. **[plugins/firebase/src/firebaseDatabase.ts](../plugins/firebase/src/firebaseDatabase.ts)** — switched to `getFirestore(app, "tile-push")` for named-DB queries
3. **[plugins/firebase/firebase/functions/index.ts](../plugins/firebase/firebase/functions/index.ts)** — hardcoded `REGION = "us-central1"`, passes `storageBucket: "tile-push-bundles"`, exports as `tile.push` (so deployed function name is `tile-push`)
4. **[plugins/firebase/firebase/public/firebase.json](../plugins/firebase/firebase/public/firebase.json)** — Firestore deploys target the `tile-push` named DB (array form with `database` field)
5. **[plugins/firebase/tsdown.config.ts](../plugins/firebase/tsdown.config.ts)** — added `hono` and `@hot-updater/server/runtime` to `alwaysBundle` so they get inlined (otherwise the deployed Cloud Function fails with "Cannot find module")

## Where things live

```
plugins/firebase/
├── src/                                 # firebase database/storage plugin source (modified)
├── firebase/
│   ├── functions/index.ts               # the Cloud Function entry (modified)
│   └── public/                          # files copied into the deploy bundle
│       ├── firebase.json                # deploy config (modified — pins to tile-push DB)
│       ├── .firebaserc                  # project alias (new — points at apptile-staging-setup)
│       ├── firestore.indexes.json       # composite indexes (unchanged)
│       └── functions/_package.json      # runtime deps template (unchanged)
├── tsdown.config.ts                     # build config (modified — alwaysBundle list)
├── dist/                                # build output (not committed)
└── deploy/                              # assembled deploy directory (gitignored)
```

## When to do what

| Goal | Skill / approach |
|---|---|
| Add a new field to bundles | Add to `Bundle` interface in `packages/core/src/types.ts` (SnakeCaseBundle auto-derives) |
| Change Firestore query behavior | Edit `plugins/firebase/src/firebaseDatabase.ts` — every `where()` chain lives here |
| Add a new HTTP route | Add to `packages/server/src/handler.ts` (universal) OR `plugins/firebase/firebase/functions/index.ts` (firebase-specific) |
| Change cohort math | Edit `packages/core/src/rollout.ts` (see `isCohortEligibleForUpdate`) |
| Add multi-tenancy filtering | NOT YET DONE. Add `where("app_id", "==", tenantId)` to every query in `firebaseDatabase.ts`, update `firestore.indexes.json` to put `app_id` as first field of every composite index, add `tenantId` extraction from URL or auth header in the Cloud Function entry |
| Bundle build | `pnpm nx build @hot-updater/firebase` from repo root |
| Deploy | See `DEPLOYMENT.md` |

## What NOT to do

- Don't try to use the `(default)` Firestore database — `tile-push` is the named DB this fork talks to
- Don't rename the function back to `hot-updater` — the URL would change and break clients
- Don't add CDN or multi-tenancy in the same change as something else — keep PRs focused
- Don't modify other plugins (aws, cloudflare, supabase, postgres, etc.) — only firebase is in scope for the SaaS
- Don't push the original hot-updater bundle name (`hot.updater` export) back into the entry file — we need `tile.push`

## Quick verification commands

```bash
# Confirm the deployed function works
curl https://tile-push-io7lmh2oqa-uc.a.run.app/api/check-update/version
# expect: {"version":"0.31.4"}

# See Firestore databases in the project
gcloud firestore databases list --project=apptile-staging-setup

# List Cloud Functions (should show tile-push)
gcloud functions list --project=apptile-staging-setup --regions=us-central1

# Confirm bundle storage bucket
gcloud storage buckets describe gs://tile-push-bundles
```

## Roadmap (planned, not yet implemented)

1. Multi-tenancy: `appId` enforcement on all queries, tenant API key auth, tenant-scoped URLs (`/t/{tenantId}/...`)
2. Cloud CDN in front of the Cloud Function for response caching
3. Migrate bundle storage from Firebase Storage to Cloudflare R2 (zero egress fees)
4. Customer-facing RN SDK fork that points at this URL
5. Customer-facing CLI fork that uploads bundles via API instead of directly to storage
6. Per-tenant admin console
7. Stripe billing
