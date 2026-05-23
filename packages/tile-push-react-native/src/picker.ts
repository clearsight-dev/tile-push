/**
 * Pure-function picker logic for v2 candidates. No React Native, no Hot
 * Updater, no I/O dependencies — just data in, data out. Tested in
 * isolation (see picker.spec.ts).
 *
 * The server-side handler (in `@hot-updater/server`'s `pluginCore.ts`)
 * walks the bundle list, tags each candidate with its v1-equivalent
 * status, and emits them in priority order:
 *
 *     [ all upgrades DESC, current bundle if found, first older
 *       (ROLLBACK), init-rollback synthetic ]
 *
 * ROLLBACK candidates (real older + synthetic init-rollback) are tagged
 * with `eligibleNumericCohorts = [1..1000]` so they always pass the
 * cohort eligibility check — mirroring v1's "no cohort check on
 * rollback" behavior.
 *
 * The picker's only job is "walk in order, return the first cohort-match."
 * No bundle ID comparison. No status branching. No rollback math. The
 * server has already encoded all of that into the list ordering + the
 * status field on each candidate.
 */

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
  /** Cohorts (1-1000) eligible for this bundle's rollout. */
  eligibleNumericCohorts?: number[];
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
 * Backward compat: if a candidate has neither `eligibleNumericCohorts`
 * nor `targetCohorts`, treat it as always-eligible (covers older server
 * versions that don't ship metadata).
 */
export function pickEligibleCandidate(
  candidates: V2Candidate[],
  cohort: string | null | undefined,
): V2Candidate | null {
  const numericCohort =
    cohort && /^\d+$/.test(cohort) ? Number.parseInt(cohort, 10) : null;

  for (const candidate of candidates) {
    const hasEligibilityMetadata =
      Array.isArray(candidate.eligibleNumericCohorts) ||
      Array.isArray(candidate.targetCohorts);

    if (!hasEligibilityMetadata) return candidate;

    if (cohort && candidate.targetCohorts?.includes(cohort)) return candidate;

    if (
      numericCohort !== null &&
      candidate.eligibleNumericCohorts?.includes(numericCohort)
    ) {
      return candidate;
    }
  }

  return null;
}
