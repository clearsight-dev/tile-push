/**
 * Pure-function picker logic for v2 candidates. No React Native, no
 * I/O dependencies — just data in, data out. Tested in isolation
 * (see picker.spec.ts).
 *
 * The server-side handler (in `@hot-updater/server`'s `pluginCore.ts`)
 * walks the bundle list, tags each candidate with its v1-equivalent
 * status, and emits them in priority order:
 *
 *     [ all upgrades DESC, current bundle if found, first older
 *       (ROLLBACK), init-rollback synthetic ]
 *
 * ROLLBACK candidates (real older + synthetic init-rollback) are
 * tagged with `rolloutCohortCount = 1000` so they pass the cohort
 * eligibility check for every numeric cohort — mirroring v1's "no
 * cohort check on rollback" behavior.
 *
 * Eligibility itself is derived from `(id, rolloutCohortCount,
 * targetCohorts)` via `isCohortEligibleForUpdate` from
 * `@hot-updater/core` — the same deterministic function used
 * server-side. No enumerated cohort array on the wire.
 */

import { isCohortEligibleForUpdate } from "@hot-updater/core";

/**
 * V2 candidate shape — matches the server response body. Defined locally
 * (rather than imported from server) so the picker remains decoupled.
 */
export type V2Candidate = {
  id: string;
  status: "UPDATE" | "ROLLBACK" | "UP_TO_DATE";
  fileUrl: string | null;
  fileHash: string | null;
  shouldForceUpdate?: boolean;
  message?: string | null;
  changedAssets?: Record<string, unknown> | null;
  manifestUrl?: string | null;
  manifestFileHash?: string | null;
  /**
   * Rollout cohort count (0-1000). Combined with `id` to deterministically
   * derive which numeric cohorts are eligible — no enumerated list needed
   * on the wire.
   */
  rolloutCohortCount?: number;
  /** Custom cohort allowlist (slug strings). */
  targetCohorts?: string[];
};

export type V2Response = {
  candidates: V2Candidate[];
};

/**
 * Pick the highest-priority candidate this device's cohort is eligible
 * for. Returns null if no candidate matches.
 *
 * Backward compat: if a candidate has neither `rolloutCohortCount` nor
 * `targetCohorts`, treat it as always-eligible (covers older server
 * versions that don't ship metadata).
 *
 * Null/undefined cohort never matches a candidate that carries
 * eligibility metadata — devices without a cohort can only fall through
 * to "no metadata = always eligible" backward-compat candidates.
 */
export function pickEligibleCandidate(
  candidates: V2Candidate[],
  cohort: string | null | undefined,
): V2Candidate | null {
  for (const candidate of candidates) {
    const hasMetadata =
      typeof candidate.rolloutCohortCount === "number" ||
      Array.isArray(candidate.targetCohorts);

    if (!hasMetadata) return candidate;
    if (cohort == null) continue;

    if (
      isCohortEligibleForUpdate(
        candidate.id,
        cohort,
        candidate.rolloutCohortCount,
        candidate.targetCohorts,
      )
    ) {
      return candidate;
    }
  }

  return null;
}
