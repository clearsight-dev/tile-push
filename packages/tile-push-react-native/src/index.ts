import { Platform } from "react-native";

import {
  HotUpdater,
  type HotUpdaterFallbackComponentProps,
  type HotUpdaterInitOptions,
  type HotUpdaterOptions,
  type ManualUpdateOptions,
  type ResolverCheckUpdateParams,
  type ResolverNotifyAppReadyParams,
  type RunUpdateProcessResponse,
} from "@hot-updater/react-native";

import { createTilePushResolver } from "./resolver";

/**
 * Default Tile Push API URL. Override via `apiUrl` for staging / self-hosted
 * deployments.
 */
const DEFAULT_API_URL = "https://apptile-staging-setup.web.app";

/**
 * Native platforms where Tile Push actually does anything. On web (RN Web,
 * Expo Snack web preview, jsdom test environments, etc.) the SDK is a no-op
 * — wrap returns an identity HOC, init does nothing, checkForUpdate resolves
 * to null. This avoids crashes from the underlying native module being
 * unavailable, while letting the same JS bundle run cross-platform.
 */
const isNative = Platform.OS === "ios" || Platform.OS === "android";

/**
 * No-op replacement for native getters when running on web. Returns
 * conservative defaults that won't trigger update flows.
 */
const webStub = {
  bundleId: "00000000-0000-0000-0000-000000000000",
  minBundleId: "00000000-0000-0000-0000-000000000000",
  cohort: "0",
  channel: "production",
  appVersion: "0.0.0",
  fingerprintHash: "",
} as const;

/**
 * Configuration accepted by `TilePush.wrap`, `TilePush.init`, and
 * `TilePush.checkForUpdate`.
 *
 * `appId` is required — it scopes every request to a tenant and determines
 * which app's bundles the device receives. Format: `tk_<slug>` (lowercase
 * alphanumeric + hyphens).
 *
 * All other fields are forwarded to the underlying SDK. Anything available
 * to `HotUpdater.wrap()` works here too.
 */
export type TilePushConfig = {
  /** Tenant identifier issued by Tile Push (format `tk_*`). */
  appId: string;
  /** Tile Push API base URL. Defaults to production. */
  apiUrl?: string;
} & Omit<HotUpdaterOptions, "baseURL" | "resolver">;

/**
 * Same as `TilePushConfig` but for `init()` (which expects the manual-mode
 * shape rather than the auto-wrap shape).
 */
export type TilePushInitConfig = {
  appId: string;
  apiUrl?: string;
} & Omit<HotUpdaterInitOptions, "baseURL" | "resolver">;

/**
 * Options accepted by `TilePush.checkForUpdate()`. The resolver is already
 * set globally by `TilePush.wrap()` or `TilePush.init()`, so no `appId`
 * needed here.
 */
export type TilePushCheckForUpdateOptions = Omit<
  ManualUpdateOptions,
  "resolver"
>;

function resolverFor(appId: string, apiUrl?: string) {
  return createTilePushResolver({
    appId,
    apiUrl: apiUrl ?? DEFAULT_API_URL,
  });
}

/**
 * Tile Push SDK entry point. Mirrors `HotUpdater` but with Tile-branded names
 * and a single required `appId` field — Tile Push handles URL routing,
 * tenant scoping, and cohort picking internally.
 *
 * ```tsx
 * import { TilePush } from '@tile-push/react-native';
 *
 * export default TilePush.wrap({
 *   appId: 'tk_acme-prod',
 *   updateStrategy: 'fingerprint',
 * })(App);
 * ```
 */
/** Identity HOC used as the wrap result on non-native platforms. */
const identityWrap = <P extends object>(Component: any): any => Component;

export const TilePush = {
  /**
   * Wrap a React component so it auto-checks for updates on mount.
   * Returns a HOC — call it with your root component.
   *
   * On web platforms (RN Web, Snack web preview), returns an identity HOC
   * that renders the wrapped component as-is without any update logic.
   */
  wrap(config: TilePushConfig): ReturnType<typeof HotUpdater.wrap> {
    if (!isNative) return identityWrap as ReturnType<typeof HotUpdater.wrap>;
    const { appId, apiUrl, ...rest } = config;
    return HotUpdater.wrap({
      ...rest,
      resolver: resolverFor(appId, apiUrl),
    });
  },

  /**
   * Initialize Tile Push globally for manual update flows. Call once at
   * app startup, then use `TilePush.checkForUpdate()` from anywhere.
   *
   * No-op on non-native platforms.
   */
  init(config: TilePushInitConfig): void {
    if (!isNative) return;
    const { appId, apiUrl, ...rest } = config;
    HotUpdater.init({
      ...rest,
      resolver: resolverFor(appId, apiUrl),
    });
  },

  /**
   * Manually trigger an update check. Uses the resolver set by the most
   * recent `wrap()` or `init()` call.
   *
   * Resolves to null on non-native platforms.
   */
  checkForUpdate(options: TilePushCheckForUpdateOptions) {
    if (!isNative) return Promise.resolve(null);
    return HotUpdater.checkForUpdate(options);
  },

  /** Apply a downloaded bundle. No-op on web. */
  updateBundle: (...args: Parameters<typeof HotUpdater.updateBundle>) =>
    isNative
      ? HotUpdater.updateBundle(...args)
      : Promise.resolve(false as ReturnType<typeof HotUpdater.updateBundle>),

  /** Get the currently-installed bundle id (UUID). */
  getBundleId: () => (isNative ? HotUpdater.getBundleId() : webStub.bundleId),

  /** Get the minimum allowed bundle id for the current native build. */
  getMinBundleId: () =>
    isNative ? HotUpdater.getMinBundleId() : webStub.minBundleId,

  /** Get this device's stable cohort value. */
  getCohort: () => (isNative ? HotUpdater.getCohort() : webStub.cohort),

  /** Override this device's cohort. No-op on web. */
  setCohort: (cohort: string) => {
    if (!isNative) return;
    HotUpdater.setCohort(cohort);
  },

  /** Get the active release channel. */
  getChannel: () => (isNative ? HotUpdater.getChannel() : webStub.channel),

  /** Get the default release channel baked into the native build. */
  getDefaultChannel: () =>
    isNative ? HotUpdater.getDefaultChannel() : webStub.channel,

  /** True if the runtime channel differs from the default. */
  isChannelSwitched: () =>
    isNative ? HotUpdater.isChannelSwitched() : false,

  /** Clear runtime channel switch and revert to default. */
  resetChannel: () =>
    isNative ? HotUpdater.resetChannel() : Promise.resolve(false),

  /** Get the host app's version. */
  getAppVersion: () =>
    isNative ? HotUpdater.getAppVersion() : webStub.appVersion,

  /** Get the native fingerprint hash. */
  getFingerprintHash: () =>
    isNative ? HotUpdater.getFingerprintHash() : webStub.fingerprintHash,

  /** Trigger a JS reload. No-op on web. */
  reload: () => {
    if (!isNative) return;
    HotUpdater.reload();
  },

  /**
   * `true` if running on a platform Tile Push can drive (iOS or Android).
   * Useful for conditional debug UI: don't show "check for update" buttons
   * on web where nothing will happen.
   */
  get isSupported() {
    return isNative;
  },
};

// Type re-exports under Tile-Push-branded aliases. Internals (the actual
// HotUpdater symbols) stay so upstream updates pull through cleanly.
export type {
  HotUpdaterFallbackComponentProps as TilePushFallbackComponentProps,
  HotUpdaterInitOptions as TilePushSDKInitOptions,
  HotUpdaterOptions as TilePushSDKOptions,
  ManualUpdateOptions as TilePushManualUpdateOptions,
  ResolverCheckUpdateParams,
  ResolverNotifyAppReadyParams,
  RunUpdateProcessResponse as TilePushRunUpdateProcessResponse,
};

// Re-export everything else (stores, error types, signature verification
// helpers, etc.) from upstream so customers don't need to import from two
// packages. The TilePush.wrap()/init() API steers them away from
// HotUpdater.* directly, but it's still available for niche use cases.
export {
  extractSignatureFailure,
  HotUpdater,
  isSignatureVerificationError,
} from "@hot-updater/react-native";
export type {
  HotUpdaterBaseURL,
  HotUpdaterResolver,
  SignatureVerificationFailure,
} from "@hot-updater/react-native";
