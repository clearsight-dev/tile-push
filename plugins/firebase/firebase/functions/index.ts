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
const cdnUrl = process.env.HOT_UPDATER_CDN_URL;

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

// In-memory response cache. Persists across requests on the same warm Cloud
// Run instance. Each instance has its own copy. TTL is short so a new deploy
// is reflected within a minute.
type CacheEntry = {
  body: string;
  status: number;
  contentType: string;
  expires: number;
};
const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

// Cache key includes tenant scope so two tenants with otherwise-identical URLs
// (after the /t/{appId}/ prefix is stripped) cannot share a cache entry.
// Cross-tenant cache leakage would be a security bug.
async function cachedFetch(
  request: Request,
  tenantScope: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const isCacheable =
    request.method === "GET" && url.pathname.startsWith(`${HOT_UPDATER_BASE_PATH}/`);
  const key = `${tenantScope ?? "_"}|${url.pathname}`;

  if (isCacheable) {
    const cached = responseCache.get(key);
    if (cached && cached.expires > Date.now()) {
      console.log(`[cache] HIT  ${key}`);
      return new Response(cached.body, {
        status: cached.status,
        headers: {
          "content-type": cached.contentType,
          "x-tile-cache": "hit",
        },
      });
    }
  }

  const response = await app.fetch(request);

  if (isCacheable && response.status === 200) {
    const clone = response.clone();
    const body = await clone.text();
    const contentType = clone.headers.get("content-type") || "application/json";
    responseCache.set(key, {
      body,
      status: response.status,
      contentType,
      expires: Date.now() + CACHE_TTL_MS,
    });
    console.log(`[cache] MISS ${key}`);
    return new Response(body, {
      status: response.status,
      headers: {
        ...Object.fromEntries(response.headers.entries()),
        "x-tile-cache": "miss",
      },
    });
  }

  return response;
}

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

    // 2. Run the entire downstream stack inside an ALS context so the
    //    firebase plugin can read appId via currentAppId() at any depth.
    const runOnce = async () => {
      const honoResponse = await cachedFetch(request, appId);
      res.status(honoResponse.status);
      for (const [key, value] of honoResponse.headers.entries()) {
        res.setHeader(key, value);
      }
      res.send(await honoResponse.text());
    };

    if (appId) {
      await tenantALS.run({ appId }, runOnce);
    } else {
      await runOnce();
    }
  },
);

// Firebase encodes hyphenated function names as nested entry points,
// e.g. "tile-push" -> "tile.push".
export const tile = {
  push: handler,
};
