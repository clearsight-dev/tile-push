import { createHotUpdater } from "@hot-updater/server/runtime";
import admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";

import { firebaseDatabase } from "../../src/firebaseDatabase";
import { firebaseFunctionsStorage } from "../../src/firebaseFunctionsStorage";
import { isValidAppId, tenantALS } from "../../src/tenantContext";
import { cliApp } from "./cliRoutes";

// Hardcoded region for tile-push SaaS deployment.
// Original hot-updater used a HotUpdater.REGION build-time substitution
// via the CLI's transformEnv helper; we bypass that by pinning here.
const REGION = "us-central1";

export const HOT_UPDATER_BASE_PATH = "/api/check-update";

if (!admin.apps.length) {
  admin.initializeApp({
    storageBucket: "tile-push-bundles",
  });
}

const adminOptions = admin.app().options;
const storageBucket = adminOptions.storageBucket;
// Default to Cloud CDN host. Override via HOT_UPDATER_CDN_URL env var if a
// different origin is needed (local emulator, alternate domain).
const cdnUrl = process.env.HOT_UPDATER_CDN_URL ?? "https://ota.tile.dev";

if (!storageBucket) {
  throw new Error(
    "Firebase runtime requires storageBucket to read bundle manifests.",
  );
}

const hotUpdater = createHotUpdater({
  database: firebaseDatabase(adminOptions),
  storages: [
    firebaseFunctionsStorage({
      ...adminOptions,
      storageBucket,
      cdnUrl,
    }),
  ],
  basePath: HOT_UPDATER_BASE_PATH,
  routes: {
    updateCheck: true,
    bundles: false,
  },
});

const app = new Hono();

app.get("/ping", (c) => {
  return c.text("pong");
});

app.mount(HOT_UPDATER_BASE_PATH, hotUpdater.handler);

// URL pattern: extract /t/{appId}/ tenant prefix from the v2 paths.
// Stripped path is forwarded to the upstream handler — upstream code has no
// knowledge of multi-tenancy. Tenant context flows via AsyncLocalStorage.
const TENANT_URL_PATTERN =
  /^(\/api\/check-update\/v2)\/t\/([^/]+)\/(.+)$/;

const handler = onRequest(
  {
    region: REGION,
  },
  async (req, res) => {
    const host = req.hostname;
    const requestPath = req.originalUrl || req.url;

    // 0. CLI routes (deploy + bundle management). Bypass the v2 tenant URL
    //    parser and the response cache — these are POST/PATCH/DELETE flows
    //    with their own auth (Bearer token, in cliAuthMiddleware) and they
    //    set ALS themselves. Caching deploys would be wrong.
    //
    //    cliApp's routes are defined without the /api/cli/ prefix (since
    //    that's a mount-style prefix, not part of the route), so strip it
    //    before forwarding. This mirrors how the upstream check-update mount
    //    strips its own base path.
    if (requestPath.startsWith("/api/cli/")) {
      const strippedPath = requestPath.slice("/api/cli".length);
      const fullUrl = new URL(strippedPath, `https://${host}`).toString();
      // firebase-functions parses JSON bodies into objects before we see
      // them. Hono expects a raw string/stream, so re-serialize. For non-
      // JSON content types we'd need a different path, but our CLI routes
      // only accept application/json today.
      let body: BodyInit | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (req.body && typeof req.body === "object") {
          body = JSON.stringify(req.body);
        } else if (typeof req.body === "string") {
          body = req.body;
        }
      }
      const cliRequest = new Request(fullUrl, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body,
      });
      const honoResponse = await cliApp.fetch(cliRequest);
      res.status(honoResponse.status);
      for (const [key, value] of honoResponse.headers.entries()) {
        res.setHeader(key, value);
      }
      // CLI/admin endpoints must never be CDN-cached. Bearer-token-scoped,
      // and POST/PATCH/DELETE flows that mutate Firestore.
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Vary", "Authorization");
      res.send(await honoResponse.text());
      return;
    }

    // 1. Detect tenant prefix; extract appId; rewrite URL.
    let appId: string | null = null;
    let effectivePath = requestPath;

    const tenantMatch = requestPath.match(TENANT_URL_PATTERN);
    if (tenantMatch) {
      const [, prefix, candidateAppId, rest] = tenantMatch;
      if (!isValidAppId(candidateAppId)) {
        res.status(400).json({
          error:
            "Invalid appId format. Expected /api/check-update/v2/t/{tk_slug}/...",
        });
        return;
      }
      appId = candidateAppId;
      // Strip /t/{appId} so the inner handler sees the canonical v2 URL
      effectivePath = `${prefix}/${rest}`;
    } else if (requestPath.startsWith("/api/check-update/v2/")) {
      // v2 path without /t/{appId}/ — explicit error rather than silently
      // running on a "default" tenant. Fails closed.
      res.status(400).json({
        error:
          "Tenant required. v2 endpoints must include /t/{appId}/ in the URL path.",
      });
      return;
    }
    // Non-v2 paths (e.g. /ping, /api/check-update/version) pass through
    // without tenant context — they don't query tenant-scoped data.

    const fullUrl = new URL(effectivePath, `https://${host}`).toString();
    const request = new Request(fullUrl, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body:
        req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    // 2. Forward to Hono. Only the fetch needs the tenant ALS context — the
    //    firebase plugin reads currentAppId() during DB/storage calls
    //    underneath app.fetch(). Express response writes happen outside the
    //    context, which is fine since they touch no tenant-scoped data.
    const honoResponse = await (appId
      ? tenantALS.run({ appId }, () => app.fetch(request))
      : app.fetch(request));

    res.status(honoResponse.status);
    for (const [key, value] of honoResponse.headers.entries()) {
      res.setHeader(key, value);
    }
    // CDN-friendly Cache-Control. Device honors max-age=60 (foreground
    // freshness), Cloud CDN honors s-maxage=2592000 (30 days). We explicitly
    // invalidate per tenant on every deploy via urlMaps.invalidateCache, so
    // the long s-maxage never causes staleness in practice.
    if (effectivePath.startsWith("/api/check-update/")) {
      res.setHeader(
        "Cache-Control",
        "public, max-age=60, s-maxage=2592000",
      );
    }

    // Strip eligibleNumericCohorts from v2 check-update responses.
    //
    // Upstream's pluginCore expands the per-bundle rollout cohort set into a
    // ~1000-element int array per candidate (~3.8KB raw, ~600B gzipped). The
    // tile-push picker (packages/tile-push-react-native/src/picker.ts) doesn't
    // consume it — it derives eligibility by calling isCohortEligibleForUpdate
    // from @hot-updater/core with (id, cohort, rolloutCohortCount,
    // targetCohorts), which is the same deterministic function the server
    // used to build the array. So the field is purely vestigial bloat.
    //
    // Cheaper to drop here than to patch upstream — keeps packages/server
    // untouched (CLAUDE.md rule 6) and the CDN caches the trimmed body
    // anyway, so this parse+stringify runs once per cache miss.
    let outBody = await honoResponse.text();
    if (
      effectivePath.startsWith("/api/check-update/v2/") &&
      honoResponse.headers.get("content-type")?.includes("application/json")
    ) {
      try {
        const parsed = JSON.parse(outBody) as {
          candidates?: Array<Record<string, unknown>>;
        };
        if (Array.isArray(parsed.candidates)) {
          for (const candidate of parsed.candidates) {
            delete candidate.eligibleNumericCohorts;
          }
          outBody = JSON.stringify(parsed);
        }
      } catch {
        // Malformed JSON — fall through with the original body untouched.
      }
    }
    res.send(outBody);
  },
);

// Firebase encodes hyphenated function names as nested entry points,
// e.g. "tile-push" -> "tile.push".
export const tile = {
  push: handler,
};
