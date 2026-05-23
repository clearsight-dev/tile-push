# @tile-push/cli (CLAUDE.md)

Agent-readable summary of this package. **Read this first** if you're a code assistant working on the Tile Push CLI or helping a customer use it.

## What this package is

`@tile-push/cli` is the customer-facing command-line tool for deploying React Native bundles to Tile Push. It's a thin **wrap layer** over the open-source [hot-updater](https://github.com/gronxb/hot-updater) CLI — same plugin architecture, but routes uploads and metadata through Tile Push's HTTP endpoints instead of the customer's own infra.

**Customer never sees "hot-updater" anywhere.** Branding, banner, config filename, error messages all say "Tile Push." Output-filtering middleware rewrites any leaking strings.

Architecturally identical wrap pattern to `@tile-push/react-native` (which wraps `@hot-updater/react-native`).

## Two responsibilities

The package exports **two things** that customers can use independently or together:

1. **A binary `tile-push`** (in `bin/tile-push.ts`) — Commander-based CLI with 9 commands
2. **Two plugins** (`tilePushStorage`, `tilePushDatabase`) — implement hot-updater's `NodeStoragePlugin` and `DatabasePlugin` interfaces by calling Tile Push's HTTP API instead of S3/Firebase directly

A customer's `tile-push.config.ts` imports the plugins and passes them to `defineConfig`. When they run `tile-push deploy`, the binary loads that config (with `HOT_UPDATER_CONFIG_NAME=tile-push` env var telling hot-updater's loader to look for `tile-push.config.*` instead of `hot-updater.config.*`), runs the standard hot-updater deploy pipeline, and the plugins route all I/O through our server.

## Auth model

**Bearer token, not OAuth.** Each customer gets one or more `tpd_<random>` tokens. Tokens are stored as SHA-256 hashes server-side under `tenants/{appId}/deployTokens[]`.

Client priority:
1. `TILE_PUSH_APP_ID` + `TILE_PUSH_TOKEN` env vars (preferred for CI)
2. `~/.tile-push/credentials.json` (chmod 600, written by `tile-push init`)
3. Throw with a helpful error

Every API request sends `Authorization: Bearer <token>`. Server middleware (`cliAuthMiddleware` in `plugins/firebase/firebase/functions/cliAuth.ts`) hashes the token, looks it up against the URL's appId's tenant doc, and rejects mismatches.

No login flow yet. `tile-push login` (planned) will be a browser-based device-code flow that mints a token via web console and writes it to `~/.tile-push/credentials.json` — auth mechanism underneath stays the same.

## The deploy flow (end-to-end)

```
tile-push deploy --platform android --rollout 100

1. bin/tile-push.ts → registerDeploy(program).action()
   - prints branded banner
   - sets HOT_UPDATER_CONFIG_NAME=tile-push
   - sets HOT_UPDATER_SKIP_BANNER=1
   - wraps in withOutputFilter() (rewrites "hot-updater" → "tile-push" in stdout)
   - calls hotUpdater.deploy(opts)

2. hot-updater's deploy() (in node_modules/hot-updater/dist):
   - loads tile-push.config.ts via unconfig
   - calls config.build.build() → bundle.zip, manifest.json on disk
   - for each artifact:
       calls storage.profiles.node.upload(key, filePath)
         → our tilePushStorage.upload() runs:
            a. compute filename = basename(filePath)
            b. POST /api/cli/t/{appId}/upload-url { key: "{key}/{filename}", contentType }
            c. server returns { uploadUrl (signed GCS PUT), storageUri, requiredHeaders }
            d. PUT bytes to uploadUrl (direct CLI → GCS, no proxy)
            e. return { storageUri } to hot-updater
   - buffers Bundle metadata in database.appendBundle() calls (no HTTP yet)
   - calls database.commitBundle() at the very end
     → our tilePushDatabase.commitBundle({changedSets}) runs:
        POST /api/cli/t/{appId}/bundles { changedSets: [{operation, data}, ...] }
        server applies inserts/updates/deletes via firebaseDatabase
                                                  inside runWithTenant(appId, ...)

3. Cloud Function side (plugins/firebase/firebase/functions/):
   - cliAuth.ts middleware: extract token, hash, look up tenant, set ALS
   - cliRoutes.ts /upload-url: bucket.file(scopedKey).getSignedUrl({write})
   - cliRoutes.ts /bundles: invoke existing firebaseDatabase.appendBundle/commitBundle
     (those methods are already tenant-aware via tenantALS — zero new tenant code)
```

**The 9-line bug to remember:** hot-updater's `upload(key, filePath)` contract expects the plugin to compose `{key}/{basename(filePath)}` for the final storage path. The first version of `tilePushStorage` forgot this and produced un-suffixed paths. Look at `src/plugins/storage.ts:91-94` — `basename(filePath)` composition is mandatory, matches `firebaseStorage`'s `createStorageKeyBuilder` pattern.

## File layout

```
packages/tile-push-cli/
├── bin/
│   └── tile-push.ts              ← Commander entry point
├── src/
│   ├── index.ts                  ← package entry exporting plugins
│   ├── branding.ts               ← printTilePushBanner, error helpers
│   ├── auth/
│   │   ├── tokenStore.ts         ← ~/.tile-push/credentials.json + env precedence
│   │   └── apiClient.ts          ← fetch wrapper with Bearer injection
│   ├── plugins/
│   │   ├── storage.ts            ← tilePushStorage() — HTTP client implementing NodeStoragePlugin
│   │   └── database.ts           ← tilePushDatabase() — HTTP client implementing DatabasePlugin
│   ├── commands/
│   │   ├── init.ts               ← `tile-push init` — write config + creds + .env
│   │   ├── deploy.ts             ← `tile-push deploy` — wraps hot-updater.deploy()
│   │   ├── bundle.ts             ← `tile-push bundle list/show/disable/enable/update/delete/promote`
│   │   ├── rollback.ts           ← `tile-push rollback <channel>`
│   │   ├── channel.ts            ← `tile-push channel [set]`
│   │   ├── fingerprint.ts        ← `tile-push fingerprint [create]`
│   │   ├── doctor.ts             ← `tile-push doctor` — diagnose setup
│   │   ├── whoami.ts             ← `tile-push whoami` — print active tenant
│   │   └── console.ts            ← `tile-push console` — open web console
│   └── utils/
│       └── outputFilter.ts       ← hijacks stdout/stderr, rewrites "hot-updater" strings
├── package.json                  ← deps: hot-updater (workspace), plugin-core, cli-tools
│                                    devDeps: commander, picocolors, open
│                                    (devDeps get bundled via tsdown inlinedDependencies)
├── tsdown.config.ts              ← bundles bin + index, dts: true, inlinedDependencies
├── tsconfig.json
└── dist/                         ← build output (gitignored)
```

## Things to know

### The wrap pattern

Each command file is **20-30 lines max** because it's just a Commander wrapper that calls the imported `hot-updater/internal/commands` function. Example:

```ts
// src/commands/rollback.ts
import { handleRollback } from "hot-updater/internal/commands";

export const registerRollback = (program: Command): void => {
  program.command("rollback")
    .argument("<channel>")
    .option("-y, --yes")
    .action(async (channel, opts) => {
      process.env.HOT_UPDATER_CONFIG_NAME = "tile-push";  // ← critical
      process.env.HOT_UPDATER_SKIP_BANNER = "1";          // ← critical
      await withOutputFilter(() => handleRollback(channel, opts));
    });
};
```

Three things every wrapper does:
1. Set `HOT_UPDATER_CONFIG_NAME=tile-push` so hot-updater finds `tile-push.config.ts`
2. Set `HOT_UPDATER_SKIP_BANNER=1` so the hot-updater banner doesn't print
3. Wrap in `withOutputFilter()` so any leaking "hot-updater" / "Hot Updater" strings in messages are rewritten

**Don't forget these three.** A new command added without them will leak the underlying tool's branding.

### Why `commander`, `picocolors`, `open` are in devDependencies (not dependencies)

So tsdown bundles them into the dist instead of leaving them as external imports. The CLI ships as a self-contained binary that doesn't fight with the customer's `node_modules` — important because customers might have an older commander hoisted (e.g. from a transitive dep).

The `inlinedDependencies: true` config in `tsdown.config.ts` writes the bundled-in versions to `package.json#inlinedDependencies` as a manifest of what was inlined (purely informational; npm ignores it).

### Why two plugins, not one

`hot-updater` separates storage and database concerns:
- **storage** = byte upload + download URLs
- **database** = bundle metadata CRUD

For Tile Push, both backends are us, but the plugin contracts are distinct interfaces from `@hot-updater/plugin-core`. Don't try to merge them — `hot-updater.deploy()` calls them at different stages.

### Server endpoints used by this CLI

All under `/api/cli/t/{appId}/`:

| Endpoint | Method | Used by |
|---|---|---|
| `/me` | GET | `whoami`, `doctor` |
| `/upload-url` | POST | `tilePushStorage.upload()` (called per file during deploy) |
| `/bundles` | POST | `tilePushDatabase.commitBundle()` (called once at end of deploy with `changedSets`) |
| `/bundles` | GET | `bundle list` |
| `/bundles/:id` | GET | `bundle show` |
| `/bundles/:id` (PATCH) | PATCH | direct update via single-bundle path (rarely used; commitBundle does most updates) |
| `/bundles/:id` (DELETE) | DELETE | direct delete via single-bundle path |
| `/channels` | GET | `bundle list` filter help |

All routes require `Authorization: Bearer <token>` and have the appId in the URL path.

**Missing endpoint** (deferred): `/storage/download-url` — used by hot-updater's patch generation. Without it, deploys print a `Partial update skipped` warning but still succeed. To add: ~20 lines in `cliRoutes.ts` calling `firebaseStorage.runtime.getDownloadUrl()`.

### How to deploy a code change to the CLI

```bash
# 1. Make your change in packages/tile-push-cli/src/
# 2. Build
pnpm --filter @tile-push/cli build

# 3. Sync to test project (in dev, before publishing)
PROJ=/Users/yaswantha/Downloads/tilepacket
rsync -a --delete packages/tile-push-cli/dist/ "$PROJ/node_modules/@tile-push/cli/dist/"
chmod +x "$PROJ/node_modules/@tile-push/cli/dist/bin/tile-push.mjs"

# 4. Test
cd "$PROJ"
TILE_PUSH_APP_ID=tk_tilepacket-test node_modules/.bin/tile-push whoami
```

### How to deploy a code change to the server

```bash
# 1. Edit plugins/firebase/firebase/functions/cliRoutes.ts (or cliAuth.ts)
# 2. Build the firebase plugin (force, NX caches aggressively)
pnpm nx build @hot-updater/firebase --skip-nx-cache

# 3. Assemble + push
cp plugins/firebase/dist/firebase/functions/index.cjs plugins/firebase/deploy/functions/index.cjs
cd plugins/firebase/deploy
firebase deploy --only functions:tile-push,hosting --project apptile-staging-setup

# IMPORTANT: include `hosting` in --only or the CDN keeps routing to the old revision (pinTag).
# See tile-push/DEPLOYMENT.md for the full gotcha explanation.
```

### Token issuance (operational)

```bash
# From plugins/firebase/deploy/functions/ (because firebase-admin must be installed there):
cd plugins/firebase/deploy/functions
cp ../../../../tile-push/scripts/issue-deploy-token.mjs _issue.mjs
node _issue.mjs tk_<appId> <label>
rm _issue.mjs

# Token is printed ONCE. Send it to the customer over Slack/email — never commit it.
```

## Common agent tasks

**Task: customer says "tile-push deploy fails"**
1. Have them run `tile-push doctor` → catches 80% of issues (missing creds, missing config, server unreachable, bad token)
2. If doctor passes, run with `DEBUG=*` for the actual stack trace
3. Check Cloud Function logs: `gcloud functions logs read tile-push --region=us-central1 --project=apptile-staging-setup --limit=20`

**Task: customer wants to deploy a hotfix to 100%**
```bash
npx tile-push deploy --platform <ios|android> --rollout 100 --force-update --message "<message>"
```

**Task: customer wants to roll back**
```bash
npx tile-push rollback production
# or for a specific bundle:
npx tile-push bundle disable <bundle-id>
```

**Task: customer wants to do a gradual rollout**
```bash
# Initial deploy at 5%
npx tile-push deploy --rollout 5

# Bump later (look up bundle id first)
LATEST=$(npx tile-push bundle list --json --limit 1 | jq -r '.data[0].id')
npx tile-push bundle update $LATEST --rollout-cohort-count 500  # 50%
```

**Task: customer's CI needs to deploy**
Set `TILE_PUSH_APP_ID` and `TILE_PUSH_TOKEN` as CI secrets. Use a CI-specific deploy token (label `"ci"`) so it can be revoked separately from a laptop token.

**Task: add a new server endpoint**
- Edit `plugins/firebase/firebase/functions/cliRoutes.ts`
- Wrap handler in `cliAuthMiddleware` (auto-applied on all `/t/:appId/*` routes)
- Use `dbFactory()` to get a fresh per-request DatabasePlugin instance
- Match patterns: `c.req.json()` for body, `c.json({...})` for response, throw 4xx via `c.json({error}, 4xx)`
- Build + deploy via the steps above

**Task: add a new CLI command**
- Make `src/commands/<name>.ts` exporting `registerXxx(program)`
- Import it in `bin/tile-push.ts` and call `registerXxx(program)` in the chain
- Use the 3-line ritual: `HOT_UPDATER_CONFIG_NAME`, `HOT_UPDATER_SKIP_BANNER`, `withOutputFilter`
- Rebuild + sync to test project

## What NOT to do

- ❌ Don't import from `@hot-updater/...` paths in customer-facing code paths — use `hot-updater/internal/commands` for command functions and `@hot-updater/plugin-core` for plugin contracts
- ❌ Don't print "hot-updater" anywhere — the output filter catches stdout/stderr but errors thrown with the string in `.message` could leak. Catch and rewrite if needed.
- ❌ Don't add direct dependency on a hot-updater storage/database plugin (firebase, aws, supabase) — we're the storage/database plugin
- ❌ Don't put secrets in `tile-push.config.ts` — it's committed to the customer's repo. Tokens live in `~/.tile-push/credentials.json` or env vars.
- ❌ Don't forget to set `HOT_UPDATER_CONFIG_NAME=tile-push` in new commands — without it, hot-updater looks for `hot-updater.config.ts` and fails with a confusing error
- ❌ Don't skip the `basename(filePath)` composition in `tilePushStorage.upload` — bundles will land at paths without `.zip` extension and devices won't be able to download them

## Quick verification commands

```bash
# CLI is correctly installed and reachable
node_modules/.bin/tile-push --version

# Auth works
node_modules/.bin/tile-push whoami

# All systems green
node_modules/.bin/tile-push doctor

# Sample API round-trip
curl -H "Authorization: Bearer $TILE_PUSH_TOKEN" \
  "https://apptile-staging-setup.web.app/api/cli/t/$TILE_PUSH_APP_ID/me"

# Verify server endpoints exist (without valid token, should be 401)
curl -i "https://apptile-staging-setup.web.app/api/cli/t/tk_test/me"
```

## Related docs

- [Tile Push fork architecture](../../tile-push/CLAUDE.md) — multi-tenancy hard rules, security model, GCP infra
- [Deployment guide](../../tile-push/DEPLOYMENT.md) — Cloud Function deploy steps, pinTag gotcha
- [Customer quickstart](./QUICKSTART.md) — install + daily-use docs for end users
- **[Bare RN Android integration](./INTEGRATION_BARE_RN_ANDROID.md)** — detailed walkthrough for non-Expo projects (validated against apptile-seed: RN 0.77, Hermes, new arch). Read this when a customer asks "how do I add tile-push to my bare RN project?" or hits the infinite restart loop.
- [hot-updater (upstream)](https://github.com/gronxb/hot-updater) — the underlying CLI we wrap
