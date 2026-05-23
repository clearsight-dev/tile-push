# Tile Push — Bare React Native (Android) Integration Guide

A complete, battle-tested walkthrough for integrating `@tile-push/react-native` and `@tile-push/cli` into a **bare React Native** Android project. Verified end-to-end against [apptile-seed](https://github.com/clearsight-dev/apptile-seed) (React Native 0.77.3, Hermes enabled, new arch enabled, ~70 native dependencies).

## When to use this guide

Use this guide if your project:
- Is bare React Native (created via `npx react-native init` or similar — NOT Expo)
- Has no `expo prebuild` step in its build pipeline
- Uses Metro as the bundler (the default)
- Targets Android

If you're using Expo, follow the [QUICKSTART.md](./QUICKSTART.md) instead — Expo's config plugin system handles the native wiring automatically.

## Why bare RN needs manual native code

Hot-updater (the engine under Tile Push) needs **one explicit line** of native code wired into your `MainApplication.kt`:

```kotlin
override fun getJSBundleFile(): String? =
    HotUpdater.getJSBundleFile(applicationContext)
```

This tells React Native: "before loading the embedded JS bundle from the APK, ask hot-updater whether there's a newer staged bundle on disk to load instead." Without this override, the device **always loads the embedded bundle** and treats every staged OTA bundle as "an update that hasn't been installed yet" — leading to an infinite restart loop on the first deploy.

In Expo projects, the `@hot-updater/react-native` Expo config plugin (`app.plugin.js`) writes this exact line for you during `expo prebuild`. In bare RN there's no prebuild step, so you write it yourself once.

This is the same pattern as `react-native-firebase`, `react-native-google-signin`, `react-native-purchases`, etc. — the JS-callable native module is autolinked, but Application-level hooks are manual.

---

## Step 1 — Add JS dependencies

Add to your `package.json`:

```json
{
  "dependencies": {
    "@tile-push/react-native": "^0.1.0",
    "@hot-updater/react-native": "^0.32.0",
    "@hot-updater/core": "^0.32.0"
  },
  "devDependencies": {
    "@tile-push/cli": "^0.1.0",
    "@hot-updater/bare": "^0.32.0",
    "@hot-updater/cli-tools": "^0.32.0",
    "@hot-updater/plugin-core": "^0.32.0",
    "hot-updater": "^0.32.0",
    "@expo/fingerprint": "^0.16.7"
  }
}
```

Then:

```bash
npm install
```

> The `@hot-updater/react-native` is a peerDependency of `@tile-push/react-native`. RN autolinking only fires for packages directly in `dependencies`, so list both explicitly. `@expo/fingerprint` is required by hot-updater's fingerprint strategy even on bare RN — it's only used at build time, doesn't ship to the device.

After `npm install`, autolinking automatically discovers `@hot-updater/react-native` and registers its native module. You'll see this in `android/app/build/generated/autolinking/src/main/java/com/facebook/react/PackageList.java` after the next build:

```java
// @hot-updater/react-native
packages.add(new HotUpdaterPackage());
```

## Step 2 — Override `getJSBundleFile()` in MainApplication.kt

Open `android/app/src/main/java/<your-package>/MainApplication.kt` and add **two lines**:

```kotlin
// 1. Add this import at the top, alongside your other imports:
import com.hotupdater.HotUpdater

// 2. Inside your `object : DefaultReactNativeHost(this)` block, add:
override fun getJSBundleFile(): String? =
    HotUpdater.getJSBundleFile(applicationContext)
```

Complete minimal example:

```kotlin
package com.myapp

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import com.hotupdater.HotUpdater                       // ← ADD THIS

class MainApplication : Application(), ReactApplication {

    override val reactNativeHost: ReactNativeHost = object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> = PackageList(this).packages
        override fun getJSMainModuleName(): String = "index"
        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG
        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED

        // ← ADD THIS METHOD
        override fun getJSBundleFile(): String? =
            HotUpdater.getJSBundleFile(applicationContext)
    }

    override val reactHost: ReactHost
        get() = getDefaultReactHost(this.applicationContext, reactNativeHost)

    override fun onCreate() {
        super.onCreate()
        SoLoader.init(this, OpenSourceMergedSoMapping)
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            load()
        }
    }
}
```

## Step 3 — Migrate from an existing custom OTA system (if any)

If your project already has a homegrown OTA mechanism (custom native module + a custom `getJSBundleFile()` reading from `documents/bundles/`), you have to remove it before adding hot-updater's override. Two systems both trying to control bundle loading on the same launch will fight each other and produce undefined behavior.

In apptile-seed's case, we found:

1. **A custom native package** `OTAManagerPackage` + `OTAManagerModule` registered via `add(OTAManagerPackage())` — **deleted** entirely
2. **A custom `getJSBundleFile()` override** in MainApplication.kt reading from `${filesDir}/bundles/index.android.bundle` with crash-revert logic — **deleted** entirely (hot-updater has its own crash-revert)
3. **A custom exception handler** that called `BundleTrackerPrefs.markCurrentBundleBroken()` on any native crash — **deleted** (hot-updater has its own recovery manager)
4. **`BundleTrackerPrefs.kt`** utility class — **kept**, because other code (`actions/index.kt`) uses it for unrelated version-code tracking. Only the OTA-related methods became dead code.

> **Critical caveat:** if your existing OTA utility class has a `lateinit val preferences` that gets initialized in `MainApplication.onCreate()`, do NOT remove the `init()` call. Other parts of your app may still depend on it. We hit a runtime crash in apptile-seed because we removed the entire OTA block but `actions/index.kt:396` still called `BundleTrackerPrefs.getLastKnownVersionCode()`. Fix: keep the `BundleTrackerPrefs.init(this)` call, just drop the bundle-related methods that hot-updater now owns.

If your project has NO existing OTA mechanism, skip this step — there's nothing to remove.

## Step 4 — Create `tile-push.config.ts` in your project root

```ts
import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";
import { tilePushDatabase, tilePushStorage } from "@tile-push/cli";

const APP_ID = "tk_<your-tenant-slug>";
const appId = process.env.TILE_PUSH_APP_ID ?? APP_ID;

export default defineConfig({
  build: bare({ enableHermes: true }),     // ← `bare` not `expo`
  storage: tilePushStorage({ appId }),
  database: tilePushDatabase({ appId }),
  updateStrategy: "fingerprint",
});
```

Two important details:

- **`bare`, not `expo`.** The `@hot-updater/bare` plugin shells out to `react-native bundle` (your project's standard bundler). The `@hot-updater/expo` plugin shells out to `expo export:embed` — that doesn't exist in bare RN projects.
- **`enableHermes: true`** must match your `android/gradle.properties` (`hermesEnabled=true`). If they disagree, the device gets a Hermes-bytecode bundle but tries to load it as plain JS (or vice versa), and the app silently fails.

## Step 5 — Wrap your root component with `TilePush.wrap`

Open your `App.tsx`:

```tsx
import { TilePush } from "@tile-push/react-native";

function App(): React.JSX.Element {
  // ... your app code ...
}

export default TilePush.wrap({
  appId: "tk_<your-tenant-slug>",
  apiUrl: "https://api.tile-push.app",       // or your custom hosting
  updateStrategy: "fingerprint",
  reloadOnForceUpdate: true,
  onProgress: (p) => console.log(`[TilePush] ${(p * 100).toFixed(0)}%`),
  onError: (e) => console.error("[TilePush] error:", e),
})(App);
```

This HOC fires `checkForUpdate()` on mount, downloads any available update in the background, and (with `reloadOnForceUpdate: true`) auto-restarts the app when a `shouldForceUpdate=true` bundle arrives.

For a richer setup with a full-screen update overlay and a debug FAB, see the [apptile-seed App.tsx](https://github.com/clearsight-dev/apptile-seed/blob/main/App.tsx) as a reference.

## Step 6 — Initialize credentials

```bash
npx tile-push init \
  --app-id tk_<your-tenant-slug> \
  --token tpd_<paste-token-from-support> \
  --bundler bare \
  --api-url https://api.tile-push.app \
  --yes
```

This writes:
- `tile-push.config.ts` (will overwrite — back up first if you customized)
- `.env` with `TILE_PUSH_APP_ID=tk_...`
- `~/.tile-push/credentials.json` (chmod 600, holds your raw token)

> ⚠️ Until the proper login flow ships, credentials are global per-user. Running `tile-push init` in a second project overwrites the first project's token. Workaround: keep a `tile-push-init.sh` script per project that re-runs init with the right values.

## Step 7 — Generate fingerprint snapshot

```bash
npx tile-push fingerprint create
```

This writes `fingerprint.json` to your project root. **Commit this file.** It records the hash of every native dependency your project depends on. On each deploy, the CLI tags the bundle with this fingerprint, and the device only accepts bundles tagged with its own native fingerprint — preventing JS-only OTA updates from being delivered to an incompatible native binary.

Re-run `tile-push fingerprint create` after every native dependency change (`npm install` of any RN module, Android Gradle update, etc.). Commit the new fingerprint and rebuild your APK.

## Step 8 — Build the release APK

```bash
cd android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

> For OTA testing, release builds are required. Debug builds always load JS from Metro at runtime, so hot-updater's downloaded bundle is bypassed.

First release build takes 5-10 minutes for projects the size of apptile-seed (large dep tree + Hermes + R8). Incremental builds (single Kotlin file change) take 1-3 minutes.

## Step 9 — Verify integration

```bash
npx tile-push doctor       # all 4 checks should be green
npx tile-push whoami       # confirms your tenant
npx tile-push bundle list  # should be empty for a fresh tenant
```

Launch the app on a connected device. The app should boot from the embedded JS bundle (whatever was in `App.tsx` when `assembleRelease` ran).

## Step 10 — First OTA deploy

Bump a visible marker in `App.tsx` (e.g. a banner color or build-id text) so you can see the new bundle visually, then:

```bash
npx tile-push deploy \
  --platform android \
  --rollout 100 \
  --force-update \
  --message "First OTA from tile-push"
```

This:
1. Runs `react-native bundle` for android (~30-60s)
2. Runs Hermes compilation (~20-40s)
3. Uploads the bundle.zip to GCS via a presigned URL
4. Commits bundle metadata to Firestore
5. Within 60s the CDN cache flushes and your device's next check returns the new bundle

Launch the app — the OTA bundle downloads, the app restarts, and the new banner appears.

To watch the OTA flow live:

```bash
adb logcat | grep -iE "TilePush|HotUpdater|BundleStorage"
```

Expected sequence:

```
ReactNativeJS: [TilePush] download 5%
ReactNativeJS: [TilePush] download 24%
ReactNativeJS: [TilePush] download 100%
BundleStorage: Download completed successfully: 8758566 bytes
BundleStorage: Verifying bundle integrity...
SignatureVerifier: Verifying hash for file: bundle.zip
BundleStorage: Bundle verification completed successfully
BundleStorage: Extracted bundle size: 19373430 bytes
BundleStorage: Setting bundle as staging
BundleStorage: setBundleURL: /data/data/<pkg>/files/bundle-store/<bundleId>/index.android.bundle
HotUpdaterRestartActivity launched
```

If you see `HotUpdaterRestartActivity` looping every ~3 seconds without the new bundle visibly applying — you skipped Step 2. The override is missing. See "Common pitfalls" below.

---

## Common pitfalls

### Infinite restart loop on first deploy

**Symptom:** Logs show `BundleStorage: setBundleURL`, then `HotUpdaterRestartActivity`, then the app restarts and the cycle repeats every 2-3 seconds.

**Cause:** `getJSBundleFile()` is not overridden in `MainApplication.kt`. The downloaded bundle is correctly downloaded + staged on disk, but the Application loads from the embedded APK bundle on every launch. So `TilePush.wrap` keeps seeing the downloaded bundle as "an update I haven't installed yet."

**Fix:** Step 2 above. Verify the import + the override are both present in `MainApplication.kt`.

**To recover an existing looping device:**

```bash
adb shell am force-stop <your-package>
adb shell pm clear <your-package>     # wipes /data/data/<pkg>/files/bundle-store/
npx tile-push bundle disable <bundleId> --yes   # disable the looping bundle server-side
```

Then rebuild your APK with the fix and reinstall.

### Bundle uploaded but device never picks it up

**Symptom:** `tile-push deploy` succeeds, `tile-push bundle list` shows the bundle, but the device says "no update available" on `Check Now`.

**Causes (most likely first):**

1. **Fingerprint mismatch.** The bundle was tagged with fingerprint X but the device's native binary has fingerprint Y. Cause: you ran `npx tile-push fingerprint create` AFTER building the APK, so the APK has the old fingerprint baked in but new deploys use the new one. Fix: rebuild the APK after every `fingerprint create`.
2. **Different `appId` deployed under.** Check `cat ~/.tile-push/credentials.json` — if it points to a different tenant than your app expects, the bundle landed in the wrong tenant. Switch credentials with `tile-push init` from your project root.
3. **Rollout cohort gating.** If you deployed with `--rollout 5`, only 0.5% of devices will receive it. Bump via `tile-push bundle update <id> --rollout-cohort-count 1000`.
4. **CDN cache (≤60s).** Hosting caches the check-update response for up to 60 seconds. Wait, or force a check via the debug FAB.

### `react-native bundle` fails during deploy

**Symptom:** Deploy fails at the `📦 Building Bundle (Android • bare)` step with `Error: Unable to resolve module ...` or similar Metro errors.

**Cause:** Your local `metro.config.js` or imports have an issue that your normal `npx react-native start` masks (Metro's dev server tolerates more than the bundle step does).

**Fix:** Run the same bundle command manually to see Metro's real error:

```bash
node node_modules/react-native/cli.js bundle \
  --entry-file index.js \
  --platform android \
  --bundle-output /tmp/test.bundle \
  --assets-dest /tmp/assets \
  --dev false \
  --minify false
```

Whatever error appears here is what tile-push hit. Fix it in Metro config / imports, then re-deploy.

### Hermes mismatch (bundle vs binary)

**Symptom:** App boots, immediately shows red error screen `Bundle is not valid` or `Invalid Hermes bytecode version`.

**Cause:** `enableHermes` in `tile-push.config.ts` doesn't match `hermesEnabled` in `android/gradle.properties`.

**Fix:** Make them match. Both true or both false. After changing, rebuild the APK AND deploy a new bundle.

### Build size grows unexpectedly

After integration, the APK is ~263 MB in debug for apptile-seed. That's normal — debug builds include all Hermes debug symbols, ProGuard maps, etc. Release builds compact to ~30-60 MB. Hot-updater itself adds ~500 KB to the APK (the recovery binary for arm64-v8a, armeabi-v7a, x86, x86_64).

### "Partial update skipped" warnings during deploy

**Symptom:** Deploy succeeds but you see:

```
▲ Partial update skipped for 019e55c7: GET /storage/download-url?... failed: HTTP 404
```

**Cause:** Today's tile-push server doesn't expose the `/storage/download-url` endpoint that the CLI uses for patch (bsdiff) generation. So patches aren't computed, and every device downloads the full bundle (~9 MB) on each update instead of a tiny diff (~300 KB).

**Status:** Tracked as a tomorrow-task. The deploy itself succeeds — only patch generation is skipped.

---

## What changes vs. self-hosted hot-updater

| Concern | Self-hosted hot-updater | Tile Push SaaS |
|---|---|---|
| Storage plugin | `@hot-updater/firebase` / `aws` / `supabase` (requires creds) | `tilePushStorage()` from `@tile-push/cli` (HTTP client, no creds) |
| Database plugin | `firebaseDatabase()` / `awsDatabase()` etc. | `tilePushDatabase()` (HTTP client) |
| Bundle download URL | Direct S3/GCS URL the device hits | Same — server returns CDN URL backed by GCS |
| Auth | Customer's AWS/Firebase creds in `.env` | Tile Push deploy token (Bearer) in `~/.tile-push/credentials.json` |
| Tenant scoping | None — one customer per deployment | URL-based (`/t/{appId}/...`) — many customers per server |
| Patch generation | Works (CLI has storage creds) | Currently broken (CLI tries CLI-side gen; pending server-side rewrite) |
| CDN | Customer's CDN setup (Cloudflare/CloudFront/etc.) | Firebase Hosting (60s TTL; CDN with purge-on-deploy planned) |

If you've integrated hot-updater self-hosted before, **everything in the JS/native layer is identical** — only the storage and database plugins differ. The `TilePush.wrap` is a thin shim over `HotUpdater.wrap` that injects a tenant-aware resolver.

---

## Reference: what each file does

```
your-app/
├── tile-push.config.ts            # what build/storage/database plugins to use
├── fingerprint.json               # snapshot of native deps for compat checks
├── .env                           # TILE_PUSH_APP_ID for env-var override (optional)
├── App.tsx                        # wraps your root with TilePush.wrap
├── android/
│   ├── app/
│   │   ├── build.gradle           # unchanged — autolinking handled
│   │   └── src/main/java/<pkg>/
│   │       └── MainApplication.kt # ← override getJSBundleFile() (manual edit)
│   ├── settings.gradle            # unchanged — autolinkLibrariesFromCommand
│   └── gradle.properties          # ensure hermesEnabled matches enableHermes
├── node_modules/
│   ├── @tile-push/cli/            # CLI binary + plugins
│   ├── @tile-push/react-native/   # JS wrapper + types
│   ├── @hot-updater/react-native/ # peerDep — native Kotlin/Swift module
│   ├── @hot-updater/bare/         # build plugin (shells out to react-native bundle)
│   └── hot-updater/               # CLI internals (commands the wrapper invokes)
└── ~/.tile-push/credentials.json  # global-per-user deploy token (chmod 600)
```

---

## Troubleshooting cheatsheet

```bash
# Inspect what's deployed to your tenant
npx tile-push bundle list
npx tile-push bundle show <bundle-id>

# Verify your CLI is authenticated to the right tenant
npx tile-push whoami
npx tile-push doctor

# Watch device-side OTA activity
adb logcat | grep -iE "TilePush|HotUpdater|BundleStorage|SignatureVerifier"

# Manually trigger a check from the device (if you embed the debug FAB)
# OR: force-stop + relaunch to fire checkForUpdate on next boot
adb shell am force-stop com.your.app

# Inspect a bundle's storage path in GCS
gcloud storage ls gs://tile-push-bundles/t/<appId>/<bundleId>/

# Download + verify a bundle's actual Hermes bytecode (magic c61fbc03)
curl -sS "https://storage.googleapis.com/tile-push-bundles/t/<appId>/<bundleId>/bundle.zip" -o /tmp/b.zip
unzip -p /tmp/b.zip index.android.bundle | head -c 4 | od -An -tx1

# Roll back if a deploy goes bad
npx tile-push rollback production    # disables most recent bundle on channel
# Devices on the bad bundle revert to previous enabled bundle on next check.

# Recover a looped device
adb shell pm clear com.your.app      # wipes bundle-store, app starts from embedded
```

---

## Validation: apptile-seed reference deployment

This integration was validated end-to-end against **apptile-seed** with:
- React Native 0.77.3
- New Architecture enabled (`IS_NEW_ARCHITECTURE_ENABLED=true`)
- Hermes enabled
- ~70 native dependencies (Firebase, MoEngage, CleverTap, Sentry, OneSignal, Shopify, Stripe, Klaviyo, Logrocket, ZegoExpress, etc.)
- Custom apptile OTA system fully removed
- Tested on Pixel 9 Pro XL, Android 15

The reference deployment delivers a JS update from `tile-push deploy` to the device in **8-10 seconds** end-to-end:

| Step | Time |
|---|---|
| `tile-push deploy` build + upload + commit | 5-8s |
| Device next `checkForUpdate` | <1s (after CDN cache flush, up to 60s) |
| Bundle download (9 MB at ~5 MB/s on wifi) | 2-3s |
| Hash verification + extraction + stage | <1s |
| App restart + RN bridge re-init | 1-2s |

Full OTA round-trip from "push to my CLI" to "user sees new banner" is **under 30 seconds** on a warm CDN.

---

## See also

- **[QUICKSTART.md](./QUICKSTART.md)** — Customer-facing quickstart (covers Expo flow too)
- **[CLAUDE.md](./CLAUDE.md)** — Agent-readable architecture summary for code assistants
- **[tile-push/CLAUDE.md](../../tile-push/CLAUDE.md)** — Server-side multi-tenancy rules
- **[hot-updater (upstream)](https://github.com/gronxb/hot-updater)** — The OSS OTA engine Tile Push wraps
