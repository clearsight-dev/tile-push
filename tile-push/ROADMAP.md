# Tile Push — Roadmap to Demo

Captured at the end of a high-productivity day. This doc is the starting point for tomorrow. If context compacts, **read this first** — it has the complete picture of what's done, what's left, and the priority order for the demo.

## What's done (end of today)

| Capability | Status | Where to look |
|---|---|---|
| **Multi-tenant server** — `appId`-scoped storage + Firestore + AsyncLocalStorage isolation | ✅ Production-deployed on `apptile-staging-setup` GCP project | [tile-push/CLAUDE.md](./CLAUDE.md) hard rules; [plugins/firebase/src/firebaseDatabase.ts](../plugins/firebase/src/firebaseDatabase.ts) |
| **`@tile-push/react-native` SDK** — wraps `@hot-updater/react-native` with `TilePush.wrap({appId})` | ✅ Working, tested on tilepacket (Expo) + apptile-seed (bare RN) | [packages/tile-push-react-native/](../packages/tile-push-react-native/) |
| **`@tile-push/cli`** — full deploy CLI wrapping hot-updater's commands | ✅ 9 commands: init, deploy, bundle, rollback, channel, fingerprint, whoami, console, doctor | [packages/tile-push-cli/](../packages/tile-push-cli/), see [CLAUDE.md](../packages/tile-push-cli/CLAUDE.md) |
| **Server endpoints** under `/api/cli/t/{appId}/` — Bearer-token auth, presigned GCS uploads, bundle CRUD | ✅ Cloud Function `tile-push` in `us-central1` | [plugins/firebase/firebase/functions/cliRoutes.ts](../plugins/firebase/firebase/functions/cliRoutes.ts) |
| **End-to-end OTA verified** on physical device (Pixel 9 Pro XL, Android 15) | ✅ Apptile-seed: blue banner deployed via `tile-push deploy` → device picked it up + applied. Tilepacket: orange/red banners earlier in the day. | logs in conversation |
| **Docs** — QUICKSTART, CLAUDE.md (agent-readable), INTEGRATION_BARE_RN_ANDROID, DEPLOYMENT | ✅ All in `packages/tile-push-cli/` and `tile-push/` | links in this doc |

---

## 🚨 Tomorrow's critical path for demo (priority order)

### 1. Per-project credentials architecture (UX-blocker for demo)

**Problem we hit today:** `~/.tile-push/credentials.json` is a single global file. Running `tile-push init` in apptile-seed overwrote tilepacket's creds. Then a tilepacket deploy with `TILE_PUSH_APP_ID=tk_tilepacket-test` accidentally landed in tk_apptile-seed's tenant because the env-var override required both `TILE_PUSH_APP_ID` AND `TILE_PUSH_TOKEN` together.

**Fix:**
- `~/.tile-push/credentials.json` becomes a **map keyed by appId**:
  ```json
  {
    "tk_acme-prod":      { "token": "tpd_...", "apiUrl": "..." },
    "tk_tilepacket-test":{ "token": "tpd_...", "apiUrl": "..." },
    "tk_apptile-seed":   { "token": "tpd_...", "apiUrl": "..." }
  }
  ```
- `.tile-push/project.json` per project: `{ "appId": "tk_acme-prod" }` (committed to repo, safe — no secrets)
- CLI resolution order: `TILE_PUSH_APP_ID` env > `.tile-push/project.json` > error
- Token lookup: `creds[activeAppId].token`
- New commands:
  - `tile-push login` — browser-based device-code flow (like `gh auth login`). Adds to creds map.
  - `tile-push use <appId>` — writes `.tile-push/project.json`
  - `tile-push whoami` — already exists; just needs to surface the active project file too
- Every CLI command should print `> Deploying to tk_acme (production channel)` at the top so the active tenant is unmissable

**Why P0:** today's demo would be embarrassing if a "switch projects and deploy" demo accidentally landed in the wrong tenant.

### 2. Web console (customer-facing)

**Today's state:**
- `@hot-updater/console` exists but it's branded "Hot Updater" and assumes single-tenant
- The `tile-web` repo (https://… — we need to confirm path) is where customers will open their apps
- All the server endpoints exist already (`/api/cli/t/{appId}/bundles`, `/me`, `/channels`, etc.)

**What to build:**
- Take the existing `@hot-updater/console` UI as a starting point — copy the layouts
- Rebrand to Tile Push (banner, colors, footer, page titles)
- Wire to our `/api/cli/...` endpoints instead of the OSS hot-updater backend
- Multi-tenant: customer logs in, sees the apps they own, picks one → drills into bundles
- Key screens:
  - Login / signup
  - Dashboard: list of my apps (appIds I have access to)
  - Per-app: bundle list (latest first), filter by channel + platform
  - Bundle detail: metadata, fileHash, storage URI, rollout cohort count, force-update flag, patches
  - Rollout slider: drag from 0% → 100% with live update (PATCH /bundles/:id)
  - Disable/enable toggle, rollback button
  - Deploy tokens management: list tokens (label + lastUsedAt), create new, revoke old
  - Channel manager (production / staging / etc.)
- Reuses the `/api/cli/...` endpoints — no new backend work needed for v1

**Auth for console:**
- Browser session via Firebase Auth (or whatever you already use for apptile dashboards)
- Backend session-token → permits acting as any deployToken the user owns
- Or simpler MVP: token-based, paste your `tpd_…` token to log in

**Why this matters for demo:** the CLI alone isn't a salable product — customers want to see + control bundles in a browser. Without this, the demo is just terminal screenshots.

### 3. Publish to npm

Currently `@tile-push/cli` and `@tile-push/react-native` are only in this monorepo. Customers can't `npm install` them.

**Tasks:**
- Confirm npm org `@tile-push` is registered (or create it)
- Set `publishConfig: { access: "public" }` in both packages (already set on tile-push-cli)
- Run `pnpm publish` (or `npm publish`) from each package
- Bump version in lockstep with hot-updater fork (currently 0.32.0)
- Optional: ship via `pnpm release` workflow (the repo already has a release script)

**Dependency story to fix before publish:**
- `@tile-push/react-native` lists `@hot-updater/react-native` as peerDep. Customer must install both.
- Consider promoting `@hot-updater/react-native` to a regular dep so customers only see `@tile-push/react-native` in package.json. Drawback: doesn't cleanly version-bump.
- Alternative: package it the way @react-native-firebase does — multiple sub-packages, customer installs only what they need.

**Pre-publish checklist:**
- Strip dev-only artifacts from `files:` in package.json
- Verify the LICENSE file ships (we attribute hot-updater per MIT)
- Verify TypeScript types are bundled
- Run a `npm pack` and inspect the tarball before publishing

**Why P0 for demo:** Customers can't "follow along" if they need to clone a private monorepo to install. The "5-minute setup" demo needs `npm install @tile-push/cli` to Just Work.

### 4. CDN migration (Cloud CDN + Load Balancer)

**Today:** Firebase Hosting fronts the Cloud Function with 60s TTL on check-update responses. No purge API → cache invalidation is "wait for TTL." For low-traffic tenants, cache miss rate is high.

**Goal:** Permanent cache, instant purge on deploy.

**Architecture:**
```
Domain (api.tile-push.app) 
   ↓
Cloud Global External Application Load Balancer
   ↓ (Cloud CDN enabled on URL map)
Cloud Run service (existing tile-push function)
```

- Cache headers from origin: `Cache-Control: public, max-age=31536000, immutable` on `/api/check-update/v2/**`
- Cache headers from origin: `Cache-Control: no-store` on `/api/cli/**` (deploy endpoints — never cache)
- After every successful `tile-push deploy` (server-side), the bundle commit handler fires:
  ```bash
  gcloud compute url-maps invalidate-cdn-cache tile-push-lb \
    --path "/api/check-update/v2/t/{appId}/*"
  ```
- This wipes the cache for that tenant. Within ~30s globally, every device sees fresh check-update responses.
- 1000 free invalidations/month, then $0.005 each. One invalidation per deploy = thousands of free deploys/month.

**Cost:**
- Forwarding rule: ~$18/mo flat
- Cache egress: $0.008/GB (cheaper than direct Cloud Run egress)
- For most tenants, cheaper than Firebase Hosting at scale

**Why P0 for demo:** "100% cache hit rate, devices see updates within seconds of deploy" is a hard sell vs. "60-second eventual consistency." The architecture story for tile-push relies on this.

**Alternative:** Cloudflare in front of Cloud Run. Workers + KV gives more flexibility but introduces a second cloud vendor. Stay in GCP for now.

### 5. Patch (bsdiff) generation

**Today:** Server doesn't expose `/storage/download-url`. CLI's patch-gen step fails silently with "Partial update skipped" warnings. Every device downloads full bundles (~9MB).

**Two options, decide tomorrow:**

**A) Band-aid (~30 min):** Add the `GET /api/cli/t/:appId/storage/download-url` endpoint. CLI keeps doing patch gen on customer's machine. Patches start generating, devices download ~300KB diffs.
- **Pro:** Fast, unblocks patches immediately.
- **Con:** Customer's CLI downloads previous bundles back from GCS to diff against. Wastes bandwidth + CPU on every deploy.

**B) Server-side patch gen (~1 day):** Move bsdiff to a Cloud Function background task. CLI just uploads + commits; server computes patches against N most recent bundles asynchronously.
- **Pro:** Proper SaaS architecture. CLI does nothing customer doesn't strictly own (just builds + uploads). No customer egress for patches. Centralized — bugs fixed in one place.
- **Con:** Bigger rewrite. Needs Cloud Tasks/Pub-Sub queue for async work, or a sync delay on deploy commit.

**Recommendation:** Do option A tomorrow as the band-aid (30 min), schedule option B as a post-demo cleanup.

### 6. Cleanup misplaced bundle

The cross-tenant deploy mistake from today left `019e55f6` in `tk_apptile-seed` containing tilepacket's JS. Harmless but polluting.

```bash
TILE_PUSH_APP_ID=tk_apptile-seed npx tile-push bundle disable 019e55f6-7025-7e1c-9dfd-38ab4f2896aa --yes
```

One-liner; do this first thing tomorrow.

---

## Post-demo experiments (if approved)

### Cloudflare R2 + D1 stack

If the demo is approved and we want to cut costs:

**Current GCP costs:**
- GCS egress to devices via Cloud CDN: $0.008/GB
- Cloud Function CPU: minimal (most work is offloaded to GCS via signed URLs)
- Firestore reads: cheap but adds up at scale
- Load Balancer forwarding: $18/mo flat

**Cloudflare R2 + D1 alternative:**
- **R2** = S3-compatible object storage with **$0 egress** (the big saving)
- **D1** = SQLite at the edge (replaces Firestore for bundle metadata)
- **Workers** = serverless compute (replaces Cloud Function)
- **Cache API** = built-in CDN, free with purge API

**Migration sketch:**
- Replace `firebaseStorage` plugin with an R2 plugin (S3-compatible API, mostly drop-in for `@hot-updater/aws`)
- Replace `firebaseDatabase` plugin with a D1 plugin (need to author this — schema is simple)
- Replace Cloud Function with a Cloudflare Worker (Hono.js routes already portable)
- Tenant isolation via the same URL pattern `/t/{appId}/...`

**Cost delta:** For 100 TB/mo of OTA bundle delivery:
- GCS via Cloud CDN: ~$800/mo egress
- R2: $0 egress (storage cost only, ~$15/mo for 1TB stored)
- **Net savings: ~$700/mo at this scale**

**Risks:**
- D1 row-count limits (5GB DB, 100K writes/day on free tier — fine for MVP, may need to shard at scale)
- Worker CPU limits (10ms CPU per request on free, 50ms paid — adequate for our load)
- Vendor lock-in (mitigated by hot-updater's plugin architecture — easy to swap back)

**Decide after demo lands.** Don't refactor pre-launch.

---

## Things to study tomorrow morning (per user request)

User said they "skipped reading few implementations especially the CLI rework." Here's a guided reading path for 30-60 minutes:

1. **[packages/tile-push-cli/CLAUDE.md](../packages/tile-push-cli/CLAUDE.md)** — full architecture overview (10 min)
2. **[packages/tile-push-cli/QUICKSTART.md](../packages/tile-push-cli/QUICKSTART.md)** — customer perspective (5 min)
3. **[packages/tile-push-cli/INTEGRATION_BARE_RN_ANDROID.md](../packages/tile-push-cli/INTEGRATION_BARE_RN_ANDROID.md)** — the apptile-seed walkthrough (15 min)
4. **[packages/tile-push-cli/bin/tile-push.ts](../packages/tile-push-cli/bin/tile-push.ts)** — Commander entry (2 min)
5. **[packages/tile-push-cli/src/commands/deploy.ts](../packages/tile-push-cli/src/commands/deploy.ts)** — the wrap pattern in 30 lines (3 min)
6. **[packages/tile-push-cli/src/plugins/storage.ts](../packages/tile-push-cli/src/plugins/storage.ts)** — how the CLI uploads (5 min)
7. **[packages/tile-push-cli/src/plugins/database.ts](../packages/tile-push-cli/src/plugins/database.ts)** — buffered commit via `changedSets` (5 min)
8. **[plugins/firebase/firebase/functions/cliRoutes.ts](../plugins/firebase/firebase/functions/cliRoutes.ts)** — server-side counterpart (5 min)
9. **[plugins/firebase/firebase/functions/cliAuth.ts](../plugins/firebase/firebase/functions/cliAuth.ts)** — auth middleware (3 min)
10. **[packages/tile-push-cli/src/utils/outputFilter.ts](../packages/tile-push-cli/src/utils/outputFilter.ts)** — the branding filter (2 min)

**Key architectural insight to internalize:** the CLI is a **wrap** over hot-updater (analogous to how `@tile-push/react-native` wraps `@hot-updater/react-native`). We don't reimplement deploy — we just inject tile-push plugins via config + environment variables (`HOT_UPDATER_CONFIG_NAME=tile-push`, `HOT_UPDATER_SKIP_BANNER=1`) + an output filter for branding. Total tile-push surface is ~400 LOC.

---

## Demo-day checklist (when we get there)

- [ ] All 6 P0 items above shipped
- [ ] Customer-facing docs published (probably docs.tile-push.app or similar)
- [ ] At least 2 live customer apps using tile-push (apptile-seed + tilepacket count as proofs)
- [ ] Web console accessible at console.tile-push.app
- [ ] api.tile-push.app domain pointing to the LB
- [ ] Signup flow: new customer can self-serve an appId + deploy token (or admin provisions via console)
- [ ] Demo script: 5-min deploy walkthrough (npm install → init → deploy → device updates)
- [ ] Pricing model decided (per-active-user? per-deploy? per-MB-served?)

---

## Things I might be missing (open questions for tomorrow)

- **Asset deduplication.** Today, every bundle uploads all assets even if identical to previous bundle. Content-addressed storage would dedupe at upload time. Cheap win for storage cost; needs a slight change to the CLI plugin (HEAD existing object before PUT).
- **Audit log.** Who deployed what, when, from which IP. Useful for security incidents.
- **Token rotation flow.** Today: manual Firestore edit. Should be: console UI with rotate/revoke buttons.
- **Multi-region.** Today: us-central1 only. For Indian customers, multi-region GCS bucket or edge-CDN would cut TTFB by 100+ ms.
- **Rate limiting on upload-url endpoint.** Today: no limits. A compromised deploy token could spam millions of bundles. Need per-tenant deploy quota.
- **Bundle size budgets.** Warn if a deploy is significantly larger than the previous bundle (likely a regression).
- **Webhook on deploy events.** Customers want Slack/Discord notifications on deploys.
- **Schema for `tenants/{appId}`.** Today: ad-hoc (`name`, `deployTokens[]`, `epoch?`). Should formalize.
- **iOS integration guide.** We did Android-only today. Need the equivalent INTEGRATION_BARE_RN_IOS.md (covers `AppDelegate.mm` bundleURL override + pod install).

---

Good night. Tomorrow's first action: read this doc, decide priority among the 6 P0s, knock them off one at a time.
