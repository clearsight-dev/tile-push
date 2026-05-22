# Hot Updater — Cohort-Based Rollout Algorithm

A deep-dive into how Hot Updater decides *which devices receive which bundle* during a gradual OTA rollout. Covers the device-side cohort assignment, the bundle-side rollout knobs, the eligibility check, the mathematical shuffling that makes it work, the historical lineage of the technique, and worked end-to-end examples.

---

## 1. The Problem

You have:

- A fleet of millions of installs of your React Native app.
- A new JS bundle you want to roll out **gradually** — start at 10%, watch crash rates, ramp to 50%, then 100%.
- No central registry of "who has what". Every device polls the server with "is there an update for me?".

You need to answer each poll with a yes/no that is:

| Requirement | Why |
|---|---|
| **Deterministic** | Same device, same bundle → same answer, every poll. No flapping. |
| **Stateless** | No DB row per device per bundle. Just compute on the fly. |
| **Per-bundle distinct** | Bundle A's "first 10%" must be a *different* 10% than bundle B's, so you don't always burn the same guinea pigs. |
| **Monotonic** | Ramping 10% → 25% should *add* devices, never *remove* them. |
| **Exactly balanced** | "10% rollout" should mean exactly 10% of the cohort space — not 9.2% or 10.7%. |

Hot Updater's answer is **cohort-based rollout** built on a **modular affine permutation**. The next sections explain each piece.

---

## 2. Cohort Assignment (Device Side)

On first launch, the native side of `@hot-updater/react-native` computes a **permanent cohort number 1..1000** for the device and stores it in `UserDefaults` (iOS) / `SharedPreferences` (Android).

### iOS — [`CohortService.swift`](packages/react-native/ios/HotUpdater/Internal/CohortService.swift)

```swift
private func defaultNumericCohort(for identifier: String) -> String {
    let hash = Int64(hashString(identifier))
    let normalized = Int((hash % 1000 + 1000) % 1000) + 1
    return String(normalized)
}

func getCohort() -> String {
    if let cohort = userDefaults.string(forKey: cohortKey), !cohort.isEmpty {
        return cohort
    }
    let initialCohort: String
    if let idfv = UIDevice.current.identifierForVendor?.uuidString, !idfv.isEmpty {
        initialCohort = defaultNumericCohort(for: idfv)
    } else {
        initialCohort = defaultNumericCohort(for: fallbackIdentifier())
    }
    userDefaults.set(initialCohort, forKey: cohortKey)
    return initialCohort
}
```

The hash function `(hash * 31) + char` is the classic Java-style polynomial string hash — cheap, well-distributed enough for bucketing.

### Android — `CohortService.kt`

Equivalent logic using `Settings.Secure.ANDROID_ID` as the seed.

### Key properties

- **Permanent**: once written, the cohort never changes for that install. Reinstall = new cohort.
- **Hidden from JS by default**: you don't need to do anything; `checkForUpdate()` reads it transparently.
- **Overridable**: from JS, `setCohort("123")` pins a specific numeric cohort, or `setCohort("beta-testers")` sets a *custom string* cohort. See [`native.ts:810`](packages/react-native/src/native.ts#L810).
- **Sent on every update check**: appended to the URL — see [`DefaultResolver.ts:42`](packages/react-native/src/DefaultResolver.ts#L42).

So at update-check time, the server knows: *"This device is cohort 512"* (or `"beta-testers"`, etc).

---

## 3. Bundle Rollout Fields

Every bundle row in the database has two rollout knobs ([`types.ts:140-160`](packages/core/src/types.ts#L140-L160)):

| Field | Type | Meaning |
|---|---|---|
| `rolloutCohortCount` | `0..1000` or `null` | How many of the 1000 numeric cohorts get this bundle. `0` = nobody, `1000`/`null` = everybody, `250` = exactly 25% (250 cohorts). |
| `targetCohorts` | `string[]` or `null` | Allowlist of specific cohort strings that *always* get this bundle, bypassing the percentage gate. Used for `"beta"`, `"internal"`, or pinning specific numeric cohorts. |

`targetCohorts` is intentionally **not returned to clients** — only the server uses it for the decision. That keeps allowlists private.

---

## 4. The Eligibility Check

The hot path on the server is `isCohortEligibleForUpdate(bundleId, cohort, rolloutCohortCount, targetCohorts)` in [`rollout.ts:196-241`](packages/core/src/rollout.ts#L196-L241). Decision tree:

```
1. cohort ∈ targetCohorts                          → ELIGIBLE   (allowlist bypass)
2. rolloutCohortCount ≤ 0                          → INELIGIBLE (rollout paused)
3. cohort is undefined  AND  rolloutCohortCount >= 1000 → ELIGIBLE (full rollout, anonymous device)
4. cohort is undefined  AND  rolloutCohortCount < 1000  → INELIGIBLE
5. cohort is a custom string (not numeric)         → INELIGIBLE (custom cohorts only match via targetCohorts)
6. rolloutCohortCount >= 1000                      → ELIGIBLE   (full rollout)
7. shufflePosition(bundleId, cohort) < rolloutCohortCount → ELIGIBLE
8. otherwise                                       → INELIGIBLE
```

Steps 1–6 are bookkeeping. **Step 7 is where the math lives.** That's what the rest of this document explains.

The eligibility check is plugged into `findLatestEligibleUpdateCandidate` in [`getUpdateInfo.ts:44-62`](plugins/js/src/getUpdateInfo.ts#L44-L62), which is the function every server runtime (Cloudflare Worker, Postgres, Supabase Edge Function, Firebase Function, …) calls to pick a bundle for a polling device.

---

## 5. The Shuffling: Why and How

### 5.1 Why naive thresholding fails

The cohort number 1..1000 is **permanent per device**. So this naive rule:

```
eligible iff cohort <= rolloutCohortCount
```

…would make the *same 100 devices* the guinea pigs for every gradual rollout in history. We need to shuffle the cohort-to-rollout-position mapping **per bundle**.

### 5.2 The trick — a modular affine permutation

There's a clean piece of number theory at play:

> The function `f(x) = (a·x + b) mod N` is a **bijection** on `{0, 1, …, N-1}` if and only if `gcd(a, N) = 1`.

A bijection means: every input maps to a unique output, and every output appears exactly once. That is precisely a **shuffle** of the numbers 0..N-1.

Hot Updater uses `N = 1000`. For each bundle, it derives a `(multiplier, offset)` pair from the bundle id:

```ts
// rollout.ts:68-92
function getRolloutShuffleParameters(bundleId: string) {
  let multiplier = positiveMod(hashString(`${bundleId}:multiplier`), 997);

  if (multiplier === 0) {
    multiplier = 1;
  }

  while (gcd(multiplier, NUMERIC_COHORT_SIZE) !== 1) {
    multiplier = positiveMod(multiplier + 1, NUMERIC_COHORT_SIZE);
    if (multiplier === 0) {
      multiplier = 1;
    }
  }

  const offset = positiveMod(
    hashString(`${bundleId}:offset`),
    NUMERIC_COHORT_SIZE,
  );

  return {
    multiplier,
    offset,
    inverseMultiplier: modularInverse(multiplier, NUMERIC_COHORT_SIZE),
  };
}
```

Notes:

- `multiplier` is initially `hash(bundleId + ":multiplier") mod 997`. The 997 is just a prime near 1000 — keeps the value in a reasonable range. The `while gcd != 1` loop bumps `multiplier` until it's coprime to 1000 (the bijection guarantee).
- `offset` is `hash(bundleId + ":offset") mod 1000` — no coprime requirement, it's an additive shift.
- `inverseMultiplier` is the modular multiplicative inverse of `multiplier` mod 1000, computed via the extended Euclidean algorithm in [`modularInverse`](packages/core/src/rollout.ts#L49-L66). It exists *because* gcd is 1.

### 5.3 Two directions: forward and inverse

Conceptually, the bundle's "rollout lineup" is defined in the **forward** direction:

```
cohort_at_position(p) = (multiplier · p + offset) mod 1000
```

That is: "the cohort sitting at position `p` in this bundle's lineup is `(m·p + b) mod 1000`."

The lineup is a permutation of all 1000 cohorts. Rollout then says: "the first `rolloutCohortCount` positions are eligible."

But devices know their cohort and need to look up *their own position*. So we invert:

```
cohort   = (multiplier · position + offset) mod 1000
cohort - offset = multiplier · position           (mod 1000)
inverseMultiplier · (cohort - offset) = position  (mod 1000)
```

That's exactly the computation in [`getNumericCohortRolloutPosition`](packages/core/src/rollout.ts#L153-L168):

```ts
return positiveMod(
  inverseMultiplier * (zeroBasedCohort - offset),
  NUMERIC_COHORT_SIZE,
);
```

Eligibility then becomes a single comparison:

```ts
return getNumericCohortRolloutPosition(bundleId, numericCohort)
       < normalizedRolloutCount;
```

### 5.4 Worked example with N = 10

To make it concrete, let's pretend `NUMERIC_COHORT_SIZE = 10` and that `bundle_X` hashes to `multiplier = 3, offset = 4`. (gcd(3, 10) = 1 ✓.)

**Forward — "who sits at position p?"**

| position p | (3·p + 4) mod 10 | cohort |
|---|---|---|
| 0 | 4 | **4** |
| 1 | 7 | **7** |
| 2 | 0 | **0** |
| 3 | 3 | **3** |
| 4 | 6 | **6** |
| 5 | 9 | **9** |
| 6 | 2 | **2** |
| 7 | 5 | **5** |
| 8 | 8 | **8** |
| 9 | 1 | **1** |

Lineup: `[4, 7, 0, 3, 6, 9, 2, 5, 8, 1]`. Every cohort 0..9 appears exactly once — that's the bijection. If `rolloutCohortCount = 3` (30%), positions 0, 1, 2 are eligible → cohorts **{4, 7, 0}**.

**Inverse — what the code does.** `inverseMultiplier` of 3 mod 10 is 7 (since 3·7 = 21 ≡ 1 mod 10).

```
position(cohort) = 7 · (cohort − 4) mod 10
```

Verify a few:

- cohort 4 → 7·(4−4) = **0** ✓
- cohort 7 → 7·(7−4) = 21 mod 10 = **1** ✓
- cohort 0 → 7·(0−4) = −28 → positive mod = **2** ✓
- cohort 6 → 7·(6−4) = 14 mod 10 = **4** ✓
- cohort 1 → 7·(1−4) = −21 → positive mod = **9** ✓

Same lineup, read in reverse. Eligibility = "is my position < rolloutCohortCount?"

### 5.5 End-to-end example at N = 1000

```
Bob.cohort = 512    (fixed forever, written once from IDFV)
bundle_X.rolloutCohortCount = 100

multiplier  = hash("bundle_X:multiplier") % 997    → e.g. 217 (already coprime to 1000)
offset      = hash("bundle_X:offset") % 1000       → e.g. 350
inverseMul  = modularInverse(217, 1000)            → e.g. 633   (since 217·633 ≡ 1 mod 1000)

Bob's position in bundle_X's lineup:
  = (633 · (511 − 350)) mod 1000
  = (633 · 161) mod 1000
  = 101913 mod 1000
  = 913

913 < 100 ?  NO  →  Bob does NOT get bundle_X yet.
```

Now another bundle:

```
bundle_Y.rolloutCohortCount = 100
multiplier  = hash("bundle_Y:multiplier") % 997    → totally different number
offset      = hash("bundle_Y:offset") % 1000       → totally different number
inverseMul  = modularInverse(...)

Bob's position in bundle_Y's lineup
  → e.g. 47

47 < 100 ?  YES  →  Bob gets bundle_Y at the same 10% rollout.
```

Cohort 512 is **early** for bundle_Y and **late** for bundle_X. The shuffle is bundle-specific. That's the whole point.

---

## 6. Where Did This Algorithm Come From?

The technique is **not invented by Hot Updater**. It's a clean reuse of math that's been around for centuries, packaged for a 21st-century use case.

### 6.1 The affine cipher (~Renaissance)

The form `f(x) = (a·x + b) mod N` is literally called the **affine cipher** and is one of the earliest cryptographic primitives:

- **Caesar cipher** (~50 BCE): `f(x) = (x + b) mod 26`. One parameter — pure shift.
- **Affine cipher**: `f(x) = (a·x + b) mod 26`. Two parameters — multiplier *and* shift. For the English alphabet you get 26 · φ(26) = 26 · 12 = 312 valid keys (φ is Euler's totient — counts values coprime to 26).

The "multiplier must be coprime to N for the map to be a bijection" fact is foundational number theory. The set of values coprime to N forms the **multiplicative group of units modulo N**, written `(ℤ/Nℤ)*`. Gauss formalized this in *Disquisitiones Arithmeticae* (1801). Euler's theorem (1763) gave us the inverse-existence guarantee that makes modular inverse computation work.

### 6.2 Linear Congruential Generators (1949)

The same `(a·x + b) mod m` form re-enters computing in 1949 when D. H. Lehmer proposes the **Linear Congruential Generator (LCG)** for pseudo-random numbers:

```
x_{n+1} = (a · x_n + c) mod m
```

For decades, `rand()` in standard C libraries was a tuned LCG. The famous tunings (Numerical Recipes, glibc, MINSTD, Park-Miller) are just hand-picked `(a, c, m)`. The **Hull-Dobell theorem (1962)** characterizes which choices give a full period — and the conditions are precisely the coprime requirements that Hot Updater's gcd loop enforces.

**Hot Updater's shuffle is, mathematically, a single step of an LCG used as a deterministic permutation.**

### 6.3 The pattern in modern infrastructure

The "deterministic-bucket-from-(id, salt)" idea is everywhere:

- **Feature flag platforms** — LaunchDarkly, Optimizely, GrowthBook, Statsig. They typically use `hash(salt + userId) % N < threshold`. Same shape.
- **Consistent hashing** (Karger et al. 1997) — used in Cassandra, DynamoDB, CDNs.
- **Sharded databases** — `shardId = hash(userId) % numShards`.
- **A/B test bucketing** — identical to feature flags.

The shared intuition:

> "I have a population and I need to deterministically slice it into stable, reproducible groups, with no central registry. So I'll use a hash function as a virtual coin flip that always returns the same answer for the same input."

### 6.4 Why *affine permutation*, instead of just hashing?

A simpler alternative would be:

```ts
isEligible = hash(bundleId + ":" + cohort) % 1000 < rolloutCohortCount;
```

That works, and most feature-flag systems do exactly that. So why the extra ceremony — multipliers, gcd loop, modular inverse?

**Answer: exact balance.**

- **Raw hash-and-threshold**: at 10% rollout you get *approximately* 100 cohorts eligible, with binomial variance. Maybe 91, maybe 108. Hashing distributes evenly *in expectation*, not *exactly*.
- **Affine permutation on 1..1000**: it's a true bijection. Each of the 1000 cohorts lands on a unique position 0..999. Taking "the first 100 positions" gives you **exactly** 100 cohorts. Every bundle. No variance.

So "10% rollout" means *literally* 100 cohorts, not "around 100." Cleaner numbers on dashboards, predictable blast radius, easier capacity planning.

You also get **perfect monotonicity** for free: ramping 10% → 25% adds exactly 150 cohorts, all new — nobody flips off.

### 6.5 Distilled intuition

The construction falls out of four stacked constraints:

| Constraint | What it forces |
|---|---|
| "Same answer every time, no DB lookup" | Pure function of inputs → hash-based scheme |
| "Different bundles shuffle differently" | Seed the function with `hash(bundleId)` |
| "Exactly N/1000 cohorts at N permille" | Must be a **bijection**, not a probabilistic threshold |
| "Cheap to compute, invertible both ways" | Simplest seedable permutation family → **affine map mod 1000** |

Once you list those constraints, the affine cipher is the minimum-viable construction. Hot Updater's author didn't invent the tool — they recognized that a 2000-year-old cipher happens to be the cleanest fit for gradual rollout.

(If you wanted fancier "shuffling looks random" properties, you'd reach for a **Format-Preserving Encryption** scheme like a 3-round Feistel network over `[0, 1000)`. Same goal, more code. The affine map is the elegant minimum.)

---

## 7. Custom (Non-Numeric) Cohorts

A cohort can also be a **string** like `"beta"`, `"internal"`, `"qa-jakarta"`. Used for explicit allowlists.

- **Validation**: `^[a-z0-9-]+$`, max 64 chars. See [`rollout.ts:6`](packages/core/src/rollout.ts#L6) and [`isCustomCohort`](packages/core/src/rollout.ts#L131-L140).
- **Behavior**: custom cohorts are **only** matched via `targetCohorts`. They do not participate in the numeric percentage rollout at all — `getNumericCohortValue` returns `null` for them, and the eligibility function returns `false` at step 5 of §4 above.
- **Set from JS**: `setCohort("beta")` ([`native.ts:810`](packages/react-native/src/native.ts#L810)) overwrites whatever numeric cohort the device had.

Typical use:

```ts
// Mark internal builds as beta cohort
import { setCohort } from "@hot-updater/react-native";
if (__DEV__ || isInternalBuild) {
  setCohort("beta");
}
```

Then on the dashboard you create a bundle with `targetCohorts: ["beta"]` and `rolloutCohortCount: 0` — only beta devices receive it.

---

## 8. Properties Summary

| Property | How it's achieved |
|---|---|
| **Deterministic** | Eligibility is a pure function of `(bundleId, cohort, rolloutCohortCount, targetCohorts)`. |
| **Stateless** | No DB row per (device, bundle). Server just hashes the bundle id and computes the position. |
| **Per-bundle reshuffle** | `multiplier` and `offset` come from `hash(bundleId)`. Different bundle → different shuffle. |
| **No collisions** | gcd-coprime guarantee → bijection. Each of 1000 cohorts gets a unique position 0..999. |
| **Exact balance** | Bijection guarantees: rollout of N permille = exactly N cohorts eligible. No statistical wobble. |
| **Monotonic** | Increasing `rolloutCohortCount` only adds eligible cohorts; never removes any. |
| **Allowlistable** | `targetCohorts` short-circuits the percentage gate for tagged devices. |
| **Privacy of allowlists** | `targetCohorts` lives only in the DB / server logic; never sent to clients. |
| **Custom string cohorts** | Routed exclusively through `targetCohorts`. Numeric percentage doesn't apply. |

---

## 9. Code Reference Map

| Concern | Location |
|---|---|
| Device-side cohort generation (iOS) | [`CohortService.swift`](packages/react-native/ios/HotUpdater/Internal/CohortService.swift) |
| Device-side cohort generation (Android) | [`CohortService.kt`](packages/react-native/android/src/main/java/com/hotupdater/CohortService.kt) |
| JS-side `setCohort` / `getCohort` | [`native.ts:810`](packages/react-native/src/native.ts#L810) |
| Sending cohort on update check | [`DefaultResolver.ts:42`](packages/react-native/src/DefaultResolver.ts#L42) |
| Cohort validation / normalization | [`rollout.ts:112-145`](packages/core/src/rollout.ts#L112-L145) |
| Per-bundle shuffle parameters | [`rollout.ts:68-92`](packages/core/src/rollout.ts#L68-L92) |
| Position computation (the inverse map) | [`rollout.ts:153-168`](packages/core/src/rollout.ts#L153-L168) |
| Eligibility check (the public API) | [`rollout.ts:196-241`](packages/core/src/rollout.ts#L196-L241) |
| Update-info plumbing | [`getUpdateInfo.ts`](plugins/js/src/getUpdateInfo.ts) |
| Bundle schema (`rolloutCohortCount`, `targetCohorts`) | [`types.ts:140-160`](packages/core/src/types.ts#L140-L160) |

---

## 10. Putting It All Together — A Full Trace

A device polls the server. Walk through every step.

**Device side (one-time, at first launch):**

1. Native code reads IDFV (iOS) or ANDROID_ID.
2. Computes `cohort = (hash(IDFV) % 1000) + 1 = 512`.
3. Writes `"512"` to `UserDefaults` under key `HotUpdater_CustomCohort`. Persisted forever.

**Device side (every update check):**

4. JS calls `checkForUpdate()`.
5. Native side returns `cohort = "512"`.
6. JS POSTs (or GETs) to the configured update endpoint with `{ platform, appVersion, channel, bundleId, cohort: "512" }`.

**Server side (per request):**

7. Load all bundles matching `platform`, `channel`, `appVersion` semver, `enabled = true`.
8. For each candidate bundle (newest first):
   - If `cohort` ("512") is in `bundle.targetCohorts` → eligible. Return this bundle.
   - Else compute `position = inverseMul(bundleId) · (511 − offset(bundleId)) mod 1000`.
   - If `position < bundle.rolloutCohortCount` → eligible. Return this bundle.
   - Else skip to the next-older bundle.
9. If none eligible, fall back to either the current bundle (if still eligible) or a rollback candidate.
10. Return `{ id, storageUri, fileHash, shouldForceUpdate, status }` to the device.

**Device side (after response):**

11. If `UPDATE`, download the bundle and reload.
12. Cohort stays 512 forever — next bundle's rollout will shuffle 512 into a different position.

That's the whole algorithm: a single modular linear permutation, seeded by `hash(bundleId)`, evaluated once per update-check request. ~50 lines of real code, doing the work of an entire feature-flag system for gradual OTA rollout.
