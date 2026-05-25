import { describe, expect, it } from "vitest";

import { pickEligibleCandidate, type V2Candidate } from "./picker";

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Always-eligible numeric rollout (mirrors server's normalized 100%). */
const FULL_ROLLOUT = 1000;
/** No numeric rollout (no device cohort 1..1000 matches). */
const NO_ROLLOUT = 0;

/**
 * Build a fake candidate with sensible defaults. Override anything via
 * the partial argument.
 */
function candidate(overrides: Partial<V2Candidate> = {}): V2Candidate {
  return {
    id: "bundle-default",
    status: "UPDATE",
    fileUrl: "https://example.com/bundle.zip",
    fileHash: "deadbeef",
    rolloutCohortCount: FULL_ROLLOUT,
    targetCohorts: [],
    ...overrides,
  };
}

/** Helper: a server response shape that the smart-bounded server emits. */
function serverBuildsCandidatesFor(args: {
  /** All enabled bundles in DB, DESC by id (newest first). */
  bundles: Array<{ id: string; rolloutCohortCount?: number }>;
  /** Device's currentBundleId (or NIL_UUID for fresh installs). */
  currentBundleId: string;
}): V2Candidate[] {
  const { bundles, currentBundleId } = args;
  const result: V2Candidate[] = [];

  for (const b of bundles) {
    if (currentBundleId === NIL_UUID) {
      result.push(
        candidate({
          id: b.id,
          status: "UPDATE",
          rolloutCohortCount: b.rolloutCohortCount ?? FULL_ROLLOUT,
        }),
      );
      continue;
    }
    const cmp = b.id.localeCompare(currentBundleId);
    if (cmp > 0 || cmp === 0) {
      result.push(
        candidate({
          id: b.id,
          status: "UPDATE",
          rolloutCohortCount: b.rolloutCohortCount ?? FULL_ROLLOUT,
        }),
      );
      continue;
    }
    // cmp < 0 — ROLLBACK candidate (always-eligible, mirroring v1)
    result.push(
      candidate({
        id: b.id,
        status: "ROLLBACK",
        rolloutCohortCount: FULL_ROLLOUT,
      }),
    );
    break;
  }

  // INIT_ROLLBACK synthetic — only when currentBundleId is real and exceeds floor
  if (currentBundleId !== NIL_UUID) {
    result.push(
      candidate({
        id: NIL_UUID,
        status: "ROLLBACK",
        fileUrl: null,
        fileHash: null,
        rolloutCohortCount: FULL_ROLLOUT,
      }),
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Scenarios from CLAUDE.md / LATENCY_ANALYSIS.md / the v2 design doc
// ─────────────────────────────────────────────────────────────────────────

describe("pickEligibleCandidate — pure picker logic", () => {
  // ─── Scenario 1: Newer eligible exists ───────────────────────────────
  it("S1: returns the newest cohort-eligible upgrade when one exists", () => {
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: NO_ROLLOUT }), // not eligible for 500
      candidate({ id: "B6", rolloutCohortCount: FULL_ROLLOUT }), // eligible
      candidate({ id: "B5", status: "UPDATE" }), // current
      candidate({ id: "B4", status: "ROLLBACK", rolloutCohortCount: FULL_ROLLOUT }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B6");
    expect(picked?.status).toBe("UPDATE");
  });

  // ─── Scenario 2: Newer not eligible, current eligible (returns current) ───
  it("S2: returns the current bundle when newer ones aren't eligible — caller treats it as up-to-date", () => {
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: NO_ROLLOUT }), // not eligible for 500
      candidate({ id: "B6", rolloutCohortCount: NO_ROLLOUT }), // not eligible
      candidate({ id: "B5", rolloutCohortCount: FULL_ROLLOUT }), // current — eligible
      candidate({ id: "B4", status: "ROLLBACK", rolloutCohortCount: FULL_ROLLOUT }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B5"); // picker returns current; resolver's id==bundleId check converts to null
  });

  // ─── Scenario 3: Newer not eligible, current not eligible → rollback ───
  it("S3: falls through to ROLLBACK candidate when neither newer nor current is eligible", () => {
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: NO_ROLLOUT }),
      candidate({ id: "B6", rolloutCohortCount: NO_ROLLOUT }),
      candidate({ id: "B5", rolloutCohortCount: NO_ROLLOUT }), // current also not eligible
      candidate({ id: "B4", status: "ROLLBACK", rolloutCohortCount: FULL_ROLLOUT }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B4");
    expect(picked?.status).toBe("ROLLBACK");
  });

  // ─── Scenario 4: Current bundle missing from list (disabled) ───
  it("S4: rollback fires when current bundle is missing from candidates (disabled)", () => {
    // Server emits no UP_TO_DATE for current — it's just not in the list
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: NO_ROLLOUT }),
      candidate({ id: "B6", rolloutCohortCount: NO_ROLLOUT }),
      // B5 (current) is absent because it was disabled by admin
      candidate({ id: "B4", status: "ROLLBACK", rolloutCohortCount: FULL_ROLLOUT }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B4");
    expect(picked?.status).toBe("ROLLBACK");
  });

  // ─── Scenario 5: Nothing eligible, no older bundle exists ───
  it("S5: falls through to INIT_ROLLBACK synthetic when nothing else matches", () => {
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: NO_ROLLOUT }),
      candidate({ id: "B6", rolloutCohortCount: NO_ROLLOUT }),
      candidate({
        id: NIL_UUID,
        status: "ROLLBACK",
        fileUrl: null,
        fileHash: null,
        rolloutCohortCount: FULL_ROLLOUT,
      }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe(NIL_UUID);
    expect(picked?.fileUrl).toBeNull();
  });

  // ─── Scenario 6: Fresh install, newer eligible exists ───
  it("S6: fresh install picks the newest eligible UPDATE", () => {
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: FULL_ROLLOUT }),
      candidate({ id: "B6", rolloutCohortCount: FULL_ROLLOUT }),
      candidate({ id: "B5", rolloutCohortCount: FULL_ROLLOUT }),
      // Note: no INIT_ROLLBACK because currentBundleId is NIL — server gates it
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B7");
  });

  // ─── Scenario 7: Fresh install, nothing eligible (no INIT_ROLLBACK) ───
  it("S7: fresh install returns null when nothing matches and no init-rollback emitted", () => {
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: NO_ROLLOUT }),
      candidate({ id: "B6", rolloutCohortCount: NO_ROLLOUT }),
      // No INIT_ROLLBACK candidate in the list for fresh installs
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked).toBeNull(); // matches v1's null return for fresh install
  });

  // ─── Scenario 8: Current below minBundleId (no INIT_ROLLBACK) ───
  it("S8: returns null when current is below minBundleId and no candidate matches", () => {
    // After native upgrade: minBundleId raised; device's current bundle is now
    // below the floor. Server filters out the old bundle and doesn't emit
    // INIT_ROLLBACK either (mirroring v1's `currentBundleId <= minBundleId → null`).
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: NO_ROLLOUT }),
      candidate({ id: "B6", rolloutCohortCount: NO_ROLLOUT }),
      candidate({ id: "B5", rolloutCohortCount: NO_ROLLOUT }),
      candidate({ id: "B4", rolloutCohortCount: NO_ROLLOUT }),
      candidate({ id: "B3", rolloutCohortCount: NO_ROLLOUT }),
      // No INIT_ROLLBACK emitted because v1 wouldn't either
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked).toBeNull();
  });

  // ─── Scenario 9: Empty DB ───
  it("S9: returns null when there are no candidates at all", () => {
    expect(pickEligibleCandidate([], "500")).toBeNull();
    expect(pickEligibleCandidate([], null)).toBeNull();
    expect(pickEligibleCandidate([], undefined)).toBeNull();
  });

  // ─── Scenario 10: Single bundle, on it, eligible ───
  it("S10: returns the single eligible bundle (caller's id check converts to null)", () => {
    const candidates = [
      candidate({ id: "B5", rolloutCohortCount: FULL_ROLLOUT }),
      candidate({
        id: NIL_UUID,
        status: "ROLLBACK",
        fileUrl: null,
        fileHash: null,
        rolloutCohortCount: FULL_ROLLOUT,
      }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B5"); // not INIT_ROLLBACK — picker takes first match
  });

  // ─── Scenario 11: Single bundle, on it, not eligible ───
  it("S11: falls through to INIT_ROLLBACK when the only candidate is not eligible", () => {
    const candidates = [
      candidate({ id: "B5", rolloutCohortCount: NO_ROLLOUT }), // not eligible
      candidate({
        id: NIL_UUID,
        status: "ROLLBACK",
        fileUrl: null,
        fileHash: null,
        rolloutCohortCount: FULL_ROLLOUT,
      }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe(NIL_UUID);
  });

  // ─── Scenario 12: Force update flag passes through unchanged ───
  it("S12: shouldForceUpdate flag is preserved on picked candidate", () => {
    const candidates = [
      candidate({
        id: "B6",
        shouldForceUpdate: true,
        rolloutCohortCount: FULL_ROLLOUT,
      }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.shouldForceUpdate).toBe(true);
  });

  // ─── Scenario 13: Multiple eligible bundles ───
  it("S13: prefers the newest bundle when multiple are cohort-eligible", () => {
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: FULL_ROLLOUT }),
      candidate({ id: "B6", rolloutCohortCount: FULL_ROLLOUT }), // also eligible
      candidate({ id: "B5", rolloutCohortCount: FULL_ROLLOUT }), // also eligible
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B7"); // first in list wins
  });

  // ─── Scenario 14: Custom cohort slug matching via targetCohorts ───
  it("S14: matches custom (non-numeric) cohort slug via targetCohorts", () => {
    const candidates = [
      candidate({
        id: "B7",
        rolloutCohortCount: NO_ROLLOUT,
        targetCohorts: ["beta-team"],
      }),
    ];
    const picked = pickEligibleCandidate(candidates, "beta-team");
    expect(picked?.id).toBe("B7");
  });

  // ─── Scenario 15: targetCohorts works for both numeric strings and custom slugs ───
  it("S15: targetCohorts handles numeric strings and custom slugs together", () => {
    const candidates = [
      candidate({
        id: "B7",
        rolloutCohortCount: NO_ROLLOUT,
        targetCohorts: ["500", "beta-team"],
      }),
    ];
    expect(pickEligibleCandidate(candidates, "500")?.id).toBe("B7");
    expect(pickEligibleCandidate(candidates, "beta-team")?.id).toBe("B7");
    expect(pickEligibleCandidate(candidates, "999")).toBeNull();
  });

  // ─── Scenario 16: Backward compat — no metadata → always eligible ───
  it("S16: treats candidates without eligibility metadata as always-eligible (backward compat)", () => {
    const noMetadata: V2Candidate = {
      id: "B7",
      status: "UPDATE",
      fileUrl: "https://example.com/x.zip",
      fileHash: "abc",
      // no rolloutCohortCount, no targetCohorts
    };
    expect(pickEligibleCandidate([noMetadata], "500")?.id).toBe("B7");
    expect(pickEligibleCandidate([noMetadata], "any-cohort")?.id).toBe("B7");
    expect(pickEligibleCandidate([noMetadata], null)?.id).toBe("B7");
    expect(pickEligibleCandidate([noMetadata], undefined)?.id).toBe("B7");
  });

  // ─── Scenario 17: Picker stops at first eligible (doesn't keep iterating) ───
  it("S17: stops at first eligible candidate — later candidates ignored even if also eligible", () => {
    const second = candidate({
      id: "B6",
      rolloutCohortCount: FULL_ROLLOUT,
    });
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: FULL_ROLLOUT }),
      second,
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B7");
    expect(picked).not.toBe(second);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Additional edge cases
// ─────────────────────────────────────────────────────────────────────────

describe("pickEligibleCandidate — edge cases", () => {
  it("returns null when cohort is null and no always-eligible candidate exists", () => {
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: 1, targetCohorts: [] }),
    ];
    expect(pickEligibleCandidate(candidates, null)).toBeNull();
  });

  it("returns null when cohort is null even if ROLLBACK has 100% rollout — null never matches numeric eligibility", () => {
    const candidates = [
      candidate({ id: "B7", rolloutCohortCount: NO_ROLLOUT }),
      candidate({
        id: "B6",
        status: "ROLLBACK",
        rolloutCohortCount: FULL_ROLLOUT,
      }),
    ];
    expect(pickEligibleCandidate(candidates, null)).toBeNull();
  });

  it("treats non-numeric cohort string as custom slug", () => {
    const candidates = [
      candidate({
        id: "B7",
        rolloutCohortCount: FULL_ROLLOUT, // 500 would match, but cohort is "beta-team"
        targetCohorts: ["beta-team"],
      }),
    ];
    expect(pickEligibleCandidate(candidates, "beta-team")?.id).toBe("B7");
  });

  it("doesn't match a candidate when neither numeric nor custom matches", () => {
    const candidates = [
      candidate({
        id: "B7",
        rolloutCohortCount: NO_ROLLOUT,
        targetCohorts: ["beta-team"],
      }),
    ];
    expect(pickEligibleCandidate(candidates, "500")).toBeNull();
    expect(pickEligibleCandidate(candidates, "alpha-team")).toBeNull();
  });

  it("returns ROLLBACK candidate with the correct status for the SDK to act on", () => {
    const candidates = [
      candidate({
        id: "B4",
        status: "ROLLBACK",
        rolloutCohortCount: FULL_ROLLOUT,
      }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.status).toBe("ROLLBACK");
  });

  it("returns INIT_ROLLBACK synthetic with null fileUrl (the reset-to-native signal)", () => {
    const candidates = [
      candidate({
        id: NIL_UUID,
        status: "ROLLBACK",
        fileUrl: null,
        fileHash: null,
        rolloutCohortCount: FULL_ROLLOUT,
      }),
    ];
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe(NIL_UUID);
    expect(picked?.fileUrl).toBeNull();
    expect(picked?.status).toBe("ROLLBACK");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Integration scenarios — picker + server-shape simulation
// ─────────────────────────────────────────────────────────────────────────

describe("end-to-end scenarios — server emits the curated list, picker selects", () => {
  it("rollout match: device sees upgrade when eligible", () => {
    const candidates = serverBuildsCandidatesFor({
      bundles: [
        { id: "B7", rolloutCohortCount: NO_ROLLOUT }, // not eligible
        { id: "B6", rolloutCohortCount: FULL_ROLLOUT }, // eligible
        { id: "B5" }, // 100% (current)
        { id: "B4" }, // 100% (older)
      ],
      currentBundleId: "B5",
    });
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B6");
    expect(picked?.status).toBe("UPDATE");
  });

  it("skip path: no upgrade eligible, current still eligible → up-to-date", () => {
    const candidates = serverBuildsCandidatesFor({
      bundles: [
        { id: "B7", rolloutCohortCount: NO_ROLLOUT }, // not eligible
        { id: "B5" }, // current, eligible
        { id: "B4" }, // older
      ],
      currentBundleId: "B5",
    });
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B5"); // picker returns current; resolver wraps as null
  });

  it("rollback path: current bundle was disabled, picker finds older eligible", () => {
    const candidates = serverBuildsCandidatesFor({
      bundles: [
        { id: "B7", rolloutCohortCount: NO_ROLLOUT }, // not eligible
        // B5 missing — disabled by admin
        { id: "B4" }, // becomes the ROLLBACK target
      ],
      currentBundleId: "B5",
    });
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B4");
    expect(picked?.status).toBe("ROLLBACK");
  });

  it("rollback to native (init-rollback): all candidates ineligible", () => {
    const candidates = serverBuildsCandidatesFor({
      bundles: [
        { id: "B7", rolloutCohortCount: NO_ROLLOUT },
        { id: "B6", rolloutCohortCount: NO_ROLLOUT },
      ],
      currentBundleId: "B5",
    });
    // None of B7, B6 are eligible. B5 (current) wasn't in the input bundles
    // (disabled), so it's not in candidates. No real older bundle either.
    // INIT_ROLLBACK fires.
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe(NIL_UUID);
    expect(picked?.fileUrl).toBeNull();
  });

  it("fresh install + newer eligible: picks newest", () => {
    const candidates = serverBuildsCandidatesFor({
      bundles: [
        { id: "B7" }, // newest
        { id: "B6" },
        { id: "B5" },
      ],
      currentBundleId: NIL_UUID,
    });
    const picked = pickEligibleCandidate(candidates, "500");
    expect(picked?.id).toBe("B7");
  });

  it("fresh install + nothing eligible: returns null (no init-rollback emitted)", () => {
    const candidates = serverBuildsCandidatesFor({
      bundles: [{ id: "B7", rolloutCohortCount: NO_ROLLOUT }],
      currentBundleId: NIL_UUID,
    });
    expect(pickEligibleCandidate(candidates, "500")).toBeNull();
  });
});
