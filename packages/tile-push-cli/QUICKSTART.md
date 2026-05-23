# Tile Push CLI — Quickstart

Multi-tenant OTA updates for React Native. Ship code changes to your app users without going through the App Store / Play Store review.

## Install

Install as a **dev dependency** in your React Native project (not globally):

```bash
npm install --save-dev @tile-push/cli
# or
pnpm add -D @tile-push/cli
# or
yarn add -D @tile-push/cli
```

> **Why dev-dep, not global?** Each project pins its own CLI version, your `package-lock.json` locks the version for CI, and new team members get the right tool by just running `npm install`.

## Setup (one-time per project)

1. **Get your deploy token.** Contact Tile Push support and we'll issue you a token tied to your `appId` (format: `tk_<your-slug>`). Save this token securely — we only show it once.

2. **Initialize your project:**

   ```bash
   npx tile-push init
   ```

   This walks you through:
   - Entering your `appId` and deploy token
   - Picking your bundler (Expo / Metro / Re.Pack — auto-detected from `package.json`)
   - Writing `tile-push.config.ts` to your project root
   - Saving credentials to `~/.tile-push/credentials.json` (locked to your user, 0600)

3. **Verify everything's wired up:**

   ```bash
   npx tile-push doctor
   ```

   Should print 4 green checks.

## Daily use

### Ship a bundle

```bash
# Full rollout (100% of users get it)
npx tile-push deploy --platform ios

# Gradual rollout
npx tile-push deploy --platform android --rollout 10

# Both platforms
npx tile-push deploy

# Force immediate update on next app launch
npx tile-push deploy --force-update --message "Critical fix for checkout"
```

### Look at deployed bundles

```bash
npx tile-push bundle list                    # most recent first
npx tile-push bundle show <bundle-id>        # full metadata
npx tile-push bundle list --json             # machine-readable
```

### Roll back

```bash
# Disable the most recent enabled bundle (users go back to previous)
npx tile-push rollback production

# Or disable a specific bundle
npx tile-push bundle disable <bundle-id>
```

### Gradual rollout management

```bash
# Bumped rollout 10% → 50%
npx tile-push bundle update <bundle-id> --rollout-cohort-count 500

# Stop the rollout
npx tile-push bundle update <bundle-id> --rollout-cohort-count 0
```

> **Cohort math:** rollout is a value 0–1000 (each unit = 0.1%). 1000 = full rollout. Cohort assignment is deterministic per device — users either always get the bundle or never get it until you bump the cohort count.

## CI integration

Set these two env vars in your CI provider:

```bash
TILE_PUSH_APP_ID=tk_yourcompany
TILE_PUSH_TOKEN=tpd_xxxxxxxxxxxxxx  # use a CI-specific deploy token
```

Then in your workflow:

```yaml
- run: npm ci
- run: npx tile-push deploy --platform ios --channel production --message "${{ github.event.head_commit.message }}"
```

**Tip:** Issue a separate deploy token labeled `"ci"` so you can revoke it independently of your laptop token if it leaks.

## Common workflows

### Bug hotfix going to everyone immediately

```bash
npx tile-push deploy --force-update --message "Hotfix: payment crash"
```

### Big new feature, careful rollout

```bash
# Day 1: 5% of users
npx tile-push deploy --rollout 5 --message "New checkout flow v2"

# Day 2 (if no error spike): bump to 25%
LATEST=$(npx tile-push bundle list --json --limit 1 | jq -r '.data[0].id')
npx tile-push bundle update $LATEST --rollout-cohort-count 250

# Day 3: 100%
npx tile-push bundle update $LATEST --rollout-cohort-count 1000
```

### Discovered a regression after deploy

```bash
# Roll back immediately (users get the previous enabled bundle on next check)
npx tile-push rollback production
```

### Promoting from staging to production

```bash
# Deploy to staging channel first
npx tile-push deploy --channel staging

# QA approves. Promote to production
npx tile-push bundle promote <bundle-id> --target production
```

## Troubleshooting

| Symptom | Try this |
|---|---|
| `No Tile Push credentials found` | Run `tile-push init`, or set `TILE_PUSH_APP_ID` + `TILE_PUSH_TOKEN` env vars |
| `401 Unknown tenant` | Your token doesn't match any deploy token on file. Contact us to issue a new one. |
| `401 Invalid token` | Token exists but doesn't match — typo on paste, or token was rotated. Run `tile-push init` again. |
| Device not picking up update | Run `tile-push bundle list` to confirm the bundle is `enabled: yes`. CDN cache is ~60s; wait, then force-restart the app. |
| `Partial update skipped` warning during deploy | Cosmetic — only affects patch generation (a delta-update optimization). Your bundle deploys fine. |

Run `tile-push doctor` whenever in doubt — it diagnoses config, credentials, server connectivity, and project setup in one go.

## How it works (5-minute version)

```
Your laptop                          Tile Push Cloud Function          GCS Bucket
─────────────────────────────────────────────────────────────────────────────────────
tile-push deploy
  │
  ├── builds bundle via Metro/Expo/...
  │
  ├── for each file (bundle, manifest, assets):
  │     ├── POST /upload-url → presigned PUT URL ─────────────────►
  │     └── PUT bytes to signed URL ────────────────────────────────────► written
  │
  └── POST /bundles { changedSets: [...metadata...] } ────────────►
                                                                   ├── verify token
                                                                   ├── write Firestore
                                                                   └── 200 OK
```

- **Bytes never go through our Cloud Function** — direct CLI → GCS via signed URL (faster, no 32MB limit, you don't pay for our egress)
- **Metadata commit is atomic at the end** — partial deploys can't land
- **Every request is tenant-scoped via Bearer token + URL path** — your token only works for your `appId`

On the device, `@tile-push/react-native` polls `/api/check-update/v2/t/{appId}/...` every app launch (or on demand). The server returns candidates ordered by priority; the SDK picks the first one your device's cohort matches and downloads it.

## What about Expo vs bare React Native?

Both work, but **bare RN requires one extra manual step** on Android — overriding `getJSBundleFile()` in `MainApplication.kt`. See the dedicated guide:

📘 **[INTEGRATION_BARE_RN_ANDROID.md](./INTEGRATION_BARE_RN_ANDROID.md)** — step-by-step for bare RN Android (validated against apptile-seed: RN 0.77, Hermes, new arch, 70+ native deps).

`tile-push init` auto-detects your bundler:

- **Expo projects** (`expo` in `package.json`) → uses `@hot-updater/expo` (Expo's config plugin auto-wires native code at prebuild)
- **Bare RN** (`react-native` only) → uses `@hot-updater/bare` (you do the one-line MainApplication edit manually — see the linked guide)
- **Re.Pack / Rock** → pass `--bundler repack` or `--bundler rock` to `init`

The storage + database layers are bundler-agnostic — they just receive a built archive and ship it.

## Security & data residency

- Bundles are stored in Google Cloud Storage in `us-central1` (multi-region replication available on request)
- Bundle metadata in Firestore `tile-push` named database, same region
- Tenant data is **physically separated** by `appId` prefix in both stores
- Deploy tokens are stored as SHA-256 hashes server-side — we cannot recover a lost token, only issue a new one
- All endpoints are HTTPS-only with `Cache-Control: immutable` on bundle bytes and `s-maxage=60` on the check-update API

## Need help?

- `tile-push doctor` — built-in diagnostics
- `tile-push <command> --help` — every command has detailed flag docs
- Email: support@tile-push.app *(coming soon)*
