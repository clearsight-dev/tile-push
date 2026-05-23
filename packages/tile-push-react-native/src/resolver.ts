import type {
  HotUpdaterResolver,
  ResolverCheckUpdateParams,
} from "@hot-updater/react-native";

/**
 * Internal v2 candidate shape. Matches the server response under
 * GET /api/check-update/v2/t/{appId}/fingerprint/...
 *
 * Defined locally (not re-imported) so the SDK remains decoupled from
 * the server package's exact type names — only the wire shape matters.
 */
type V2Candidate = {
  id: string;
  status: "UPDATE" | "ROLLBACK" | "UP_TO_DATE";
  fileUrl: string | null;
  fileHash: string;
  shouldForceUpdate?: boolean;
  message?: string | null;
  changedAssets?: Record<string, unknown>;
  manifestUrl?: string | null;
  manifestFileHash?: string | null;
  /** Cohorts (1-1000) eligible for this bundle's rollout. */
  eligibleNumericCohorts?: number[];
  /** Custom cohort allowlist (slug strings). */
  targetCohorts?: string[];
};

type V2Response = {
  candidates: V2Candidate[];
};

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Pick the highest-priority candidate eligible for this device's cohort.
 *
 * Candidates arrive DESC sorted by id (newest first), so we walk in order
 * and return the first match. If the device's cohort is in a custom
 * targetCohorts allowlist or its numeric value is in eligibleNumericCohorts,
 * the candidate is eligible.
 *
 * Backward compat: if a candidate has neither field, treat it as eligible
 * for all cohorts (covers older server versions or full rollouts that
 * omit the metadata).
 */
function pickEligibleCandidate(
  candidates: V2Candidate[],
  cohort: string | null | undefined,
): V2Candidate | null {
  const numericCohort =
    cohort && /^\d+$/.test(cohort) ? Number.parseInt(cohort, 10) : null;

  for (const candidate of candidates) {
    const hasEligibilityMetadata =
      Array.isArray(candidate.eligibleNumericCohorts) ||
      Array.isArray(candidate.targetCohorts);

    if (!hasEligibilityMetadata) {
      // Server didn't ship eligibility info — assume open rollout.
      return candidate;
    }

    if (cohort && candidate.targetCohorts?.includes(cohort)) {
      return candidate;
    }

    if (
      numericCohort !== null &&
      candidate.eligibleNumericCohorts?.includes(numericCohort)
    ) {
      return candidate;
    }
  }

  return null;
}

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
      if (!picked) {
        return null;
      }

      // Device is already on the picked bundle → no update needed.
      if (picked.id === params.bundleId) {
        return null;
      }

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
