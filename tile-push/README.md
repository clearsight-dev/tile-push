# tile-push

A multi-tenant OTA (over-the-air) update service for React Native apps. Fork of [hot-updater](https://github.com/gronxb/hot-updater), customized for SaaS deployment with per-tenant isolation, Cloud CDN, and a customer-facing CLI + SDK.

> **Repo:** https://github.com/clearsight-dev/tile-push
> **Status:** Multi-tenant MVP deployed on `https://ota.tile.dev`. Demo-ready.

## Docs by audience

| Want to... | Read |
|---|---|
| Understand how the system works end-to-end | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| Make a code change (rules + workflow) | [`CLAUDE.md`](./CLAUDE.md) |
| Deploy code to production | [`DEPLOYMENT.md`](./DEPLOYMENT.md) |
| Know exactly what's in GCP (for ops / rollback) | [`GCP_INFRASTRUCTURE.md`](./GCP_INFRASTRUCTURE.md) |
| Plan upcoming work or check what's done | [`ROADMAP.md`](./ROADMAP.md) |
| Investigate latency or cost at scale | [`LATENCY_ANALYSIS.md`](./LATENCY_ANALYSIS.md) |

## Docs by topic

| Topic | File |
|---|---|
| Multi-tenancy enforcement rules | [`CLAUDE.md` → Hard rules](./CLAUDE.md#hard-rules-for-any-code-change) |
| Cloud LB / CDN setup | [`GCP_INFRASTRUCTURE.md`](./GCP_INFRASTRUCTURE.md) + [`ARCHITECTURE.md` → Cache-Control](./ARCHITECTURE.md) |
| URL contract (`ota.tile.dev` paths) | [`GCP_INFRASTRUCTURE.md` → URL routing summary](./GCP_INFRASTRUCTURE.md#url-routing-summary-every-customer-facing-url) |
| Bundle storage layout | [`ARCHITECTURE.md` → Storage layout](./ARCHITECTURE.md) |
| Firestore schema + indexes | [`ARCHITECTURE.md` → Data model](./ARCHITECTURE.md) |
| Cache invalidation flow | [`ARCHITECTURE.md` → Cache-Control + invalidation](./ARCHITECTURE.md) |
| Customer SDK & CLI | [`packages/tile-push-react-native/README.md`](../packages/tile-push-react-native/README.md), [`packages/tile-push-cli/README.md`](../packages/tile-push-cli/README.md) |
| Bare RN Android integration walkthrough | [`packages/tile-push-cli/INTEGRATION_BARE_RN_ANDROID.md`](../packages/tile-push-cli/INTEGRATION_BARE_RN_ANDROID.md) |

## Reusable agent skills

Located in [`.agents/skills/`](../.agents/skills/), invocable via `/<skill-name>` in Claude Code:

| Skill | What it does |
|---|---|
| `tile-push-deploy` | Builds firebase plugin, syncs bundle to deploy/, runs `firebase deploy` |
| `tile-push-cdn-verify` | 5-point health check across check-update headers, bundle URLs, cache, invalidation |
| `tile-push-onboard-tenant` | Issues a deploy token for a new tenant + writes Firestore tenant doc |

## Production endpoints (quick reference)

| URL | Purpose |
|---|---|
| `https://ota.tile.dev` | Primary — Cloud CDN + LB, customer-facing |
| `https://apptile-staging-setup.web.app` | Fallback via Firebase Hosting (kept alive while consumer apps still hit it) |
| `https://tile-push-io7lmh2oqa-uc.a.run.app` | Direct Cloud Run origin (debugging only) |

See [`GCP_INFRASTRUCTURE.md`](./GCP_INFRASTRUCTURE.md) for the full resource inventory.

## Source layout

```
plugins/firebase/        Firebase plugin (Cloud Function + Firestore + Storage)
├── src/                 Plugin code (tenant-aware database + storage)
└── firebase/functions/  Cloud Function entry point + CLI routes

packages/tile-push-cli/         Customer-facing deploy CLI
packages/tile-push-react-native/ Customer-facing OTA SDK

tile-push/               Tile-push fork docs (this folder)
.agents/skills/          Reusable agent skills (this fork's + upstream's)
```

Upstream packages (`packages/core`, `packages/server`, `packages/react-native`, `packages/hot-updater`, `packages/console`) are left untouched so we can pull upstream updates indefinitely. See [`CLAUDE.md` → Rule 6](./CLAUDE.md#rule-6--dont-touch-upstream-packagesserver-packagescore-packagesreact-native).
