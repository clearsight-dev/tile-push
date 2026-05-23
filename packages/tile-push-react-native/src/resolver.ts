import type {
  HotUpdaterResolver,
  ResolverCheckUpdateParams,
} from "@hot-updater/react-native";

import { pickEligibleCandidate, type V2Response } from "./picker";

const DEFAULT_TIMEOUT_MS = 5000;

export interface TilePushResolverConfig {
  appId: string;
  apiUrl: string;
}

/**
 * Build a resolver bound to one tenant. The resolver is what the upstream
 * HotUpdater SDK calls during checkForUpdate() — it owns the network round-
 * trip, the response shape adaptation, and cohort picking.
 *
 * Customers never see this — the wrap() in src/index.ts constructs it for
 * them based on their appId.
 */
export function createTilePushResolver(
  config: TilePushResolverConfig,
): HotUpdaterResolver {
  const base = config.apiUrl.replace(/\/+$/, "");
  const tenantBase = `${base}/api/check-update/v2/t/${encodeURIComponent(config.appId)}`;

  return {
    async checkUpdate(params: ResolverCheckUpdateParams) {
      const url = buildV2Url(tenantBase, params);

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        params.requestTimeout ?? DEFAULT_TIMEOUT_MS,
      );

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: params.requestHeaders ?? {},
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.status === 400) {
        // 400 here generally means appId is malformed or missing. Surface
        // a useful error rather than a generic "check failed".
        const body = await safeText(response);
        throw new Error(
          `[Tile Push] Bad request from server (${response.status}): ${body}. ` +
            `Check that appId is configured correctly in TilePush.wrap.`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `[Tile Push] check-update failed: HTTP ${response.status}`,
        );
      }

      const data = (await response.json()) as V2Response | null;
      const candidates = data?.candidates ?? [];

      const picked = pickEligibleCandidate(candidates, params.cohort);
      if (!picked) return null;

      // If the picked candidate IS the device's current bundle, there's
      // nothing to install — the device is already on a still-valid bundle.
      // Mirrors v1's "current eligible → return null (up to date)" case.
      if (picked.id === params.bundleId) return null;

      return picked as any;
    },
  };
}

function buildV2Url(
  tenantBase: string,
  params: ResolverCheckUpdateParams,
): string {
  const enc = encodeURIComponent;
  if (params.updateStrategy === "fingerprint") {
    if (!params.fingerprintHash) {
      throw new Error(
        "[Tile Push] fingerprint strategy requires fingerprintHash. " +
          "Generate one via `npx hot-updater fingerprint` or set " +
          "updateStrategy to 'appVersion'.",
      );
    }
    return `${tenantBase}/fingerprint/${enc(params.platform)}/${enc(params.fingerprintHash)}/${enc(params.channel)}/${enc(params.minBundleId)}/${enc(params.bundleId)}`;
  }

  return `${tenantBase}/app-version/${enc(params.platform)}/${enc(params.appVersion)}/${enc(params.channel)}/${enc(params.minBundleId)}/${enc(params.bundleId)}`;
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}
