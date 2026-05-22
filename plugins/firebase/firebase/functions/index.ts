import { createHotUpdater } from "@hot-updater/server/runtime";
import admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";

import { firebaseDatabase } from "../../src/firebaseDatabase";
import { firebaseFunctionsStorage } from "../../src/firebaseFunctionsStorage";

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

const handler = onRequest(
  {
    region: REGION,
  },
  async (req, res) => {
    const host = req.hostname;
    const requestPath = req.originalUrl || req.url;
    const fullUrl = new URL(requestPath, `https://${host}`).toString();
    const request = new Request(fullUrl, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body:
        req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });
    const honoResponse = await app.fetch(request);
    res.status(honoResponse.status);
    for (const [key, value] of honoResponse.headers.entries()) {
      res.setHeader(key, value);
    }
    res.send(await honoResponse.text());
  },
);

// Firebase encodes hyphenated function names as nested entry points,
// e.g. "tile-push" -> "tile.push".
export const tile = {
  push: handler,
};
