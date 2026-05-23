import type { Bundle, Platform } from "@hot-updater/plugin-core";
import admin from "firebase-admin";
import { Hono } from "hono";

import { firebaseDatabase } from "../../src/firebaseDatabase";
import { cliAuthMiddleware, getCliAuth } from "./cliAuth";

/**
 * CLI routes for tile-push deploys. Mounted at /api/cli on the outer Hono
 * app. Every route under /t/:appId/* runs the cliAuthMiddleware, which:
 *   - validates Bearer token against /tenants/{appId}/deployTokens
 *   - sets tenantALS context for downstream firebase plugin calls
 *
 * Routes:
 *   POST   /t/:appId/upload-url   → signed GCS PUT URL
 *   POST   /t/:appId/bundles      → bulk append + commit
 *   GET    /t/:appId/bundles      → list with filters
 *   GET    /t/:appId/bundles/:id  → fetch single
 *   PATCH  /t/:appId/bundles/:id  → partial update
 *   DELETE /t/:appId/bundles/:id  → delete
 *   GET    /t/:appId/channels     → list channels
 *   GET    /t/:appId/me           → identity / token info
 *
 * The HTTP routes are thin: they validate input, then call the existing
 * firebaseDatabase / firebase-admin storage APIs which read tenant scope
 * from AsyncLocalStorage. No new tenant logic lives here.
 */

const STORAGE_BUCKET = "tile-push-bundles";
const UPLOAD_URL_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024; // 100MB cap

// firebaseDatabase is double-curried: (config) => (() => DatabasePlugin).
// The outer call builds a config-bound factory at module load. Each request
// invokes the factory to get a fresh DatabasePlugin instance — important
// because the plugin maintains a per-instance pending-changes buffer that
// must not bleed across concurrent HTTP requests.
const dbFactory = firebaseDatabase({ storageBucket: STORAGE_BUCKET });

const PLATFORMS: readonly Platform[] = ["ios", "android"];
const isPlatform = (value: unknown): value is Platform =>
  typeof value === "string" && PLATFORMS.includes(value as Platform);

const cliApp = new Hono();

cliApp.use("/t/:appId/*", cliAuthMiddleware);

// -----------------------------------------------------------------------------
// GET /t/:appId/me — identity check, used by tile-push whoami / doctor
// -----------------------------------------------------------------------------
cliApp.get("/t/:appId/me", (c) => {
  const auth = getCliAuth(c);
  return c.json({
    appId: auth.appId,
    tenantName: auth.tenantName,
    tokenLabel: auth.tokenLabel,
  });
});

// -----------------------------------------------------------------------------
// POST /t/:appId/upload-url — signed GCS PUT URL for a bundle artifact
//
// Body: { key: string, contentType?: string }
//   `key` is whatever path the CLI plugin wants under the tenant prefix —
//   typically "{bundleId}/bundle.zip", "{bundleId}/manifest.json", or
//   "assets/{fileHash}/{filename}". We don't constrain it; the CLI plugin
//   owns its layout.
//
// Response: { uploadUrl, storageUri, requiredHeaders }
//   The CLI PUTs the file bytes to uploadUrl with the requiredHeaders set,
//   then references storageUri in the bundle metadata it commits.
// -----------------------------------------------------------------------------
cliApp.post("/t/:appId/upload-url", async (c) => {
  const auth = getCliAuth(c);
  let body: { key?: string; contentType?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const key = body.key?.trim();
  if (!key) {
    return c.json({ error: "Missing required field: key." }, 400);
  }
  // Reject keys that try to escape the tenant prefix
  if (key.startsWith("/") || key.includes("..")) {
    return c.json({ error: "Invalid key: must be a relative path." }, 400);
  }

  const contentType = body.contentType ?? "application/octet-stream";
  const scopedKey = `t/${auth.appId}/${key}`;

  const bucket = admin.storage().bucket(STORAGE_BUCKET);
  const file = bucket.file(scopedKey);

  const [uploadUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + UPLOAD_URL_TTL_MS,
    contentType,
    extensionHeaders: {
      "x-goog-content-length-range": `0,${MAX_UPLOAD_SIZE_BYTES}`,
    },
  });

  return c.json({
    uploadUrl,
    storageUri: `gs://${STORAGE_BUCKET}/${scopedKey}`,
    requiredHeaders: {
      "Content-Type": contentType,
      "x-goog-content-length-range": `0,${MAX_UPLOAD_SIZE_BYTES}`,
    },
  });
});

// -----------------------------------------------------------------------------
// POST /t/:appId/bundles — apply a batch of insert/update/delete operations
//
// Body: { changedSets: [{ operation: "insert"|"update"|"delete", data: Bundle }] }
//   Matches hot-updater's createDatabasePlugin commitBundle contract: the
//   client buffers append/update/delete locally then ships the whole batch
//   in one HTTP round-trip. Server applies each in order then commits via
//   firebaseDatabase's commit cycle.
// -----------------------------------------------------------------------------
type ChangeOperation = "insert" | "update" | "delete";
interface ChangedSet {
  operation: ChangeOperation;
  data: Bundle;
}

cliApp.post("/t/:appId/bundles", async (c) => {
  let body: { changedSets?: ChangedSet[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const changedSets = body.changedSets;
  if (!Array.isArray(changedSets) || changedSets.length === 0) {
    return c.json(
      { error: "Body must include non-empty changedSets[] array." },
      400,
    );
  }

  const db = dbFactory();
  const applied: { operation: ChangeOperation; bundleId: string }[] = [];
  for (const change of changedSets) {
    const bundle = change.data;
    if (!bundle?.id) {
      return c.json(
        { error: "Each changedSet entry needs data.id." },
        400,
      );
    }
    switch (change.operation) {
      case "insert":
        if (!bundle.platform || !bundle.channel) {
          return c.json(
            { error: "insert requires data.platform and data.channel." },
            400,
          );
        }
        await db.appendBundle(bundle);
        break;
      case "update":
        await db.updateBundle(bundle.id, bundle);
        break;
      case "delete":
        await db.deleteBundle(bundle);
        break;
      default:
        return c.json(
          {
            error: `Unknown operation: ${String((change as ChangedSet).operation)}`,
          },
          400,
        );
    }
    applied.push({ operation: change.operation, bundleId: bundle.id });
  }
  await db.commitBundle();

  return c.json({ applied });
});

// -----------------------------------------------------------------------------
// GET /t/:appId/bundles — list with filters
//
// Query: ?channel=, ?platform=, ?limit=, ?cursor=
// -----------------------------------------------------------------------------
cliApp.get("/t/:appId/bundles", async (c) => {
  const url = new URL(c.req.url);
  const channel = url.searchParams.get("channel") ?? undefined;
  const platformParam = url.searchParams.get("platform");
  const platform = isPlatform(platformParam) ? platformParam : undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
  const after = url.searchParams.get("after") ?? undefined;

  if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
    return c.json({ error: "limit must be an integer between 1 and 200." }, 400);
  }

  const db = dbFactory();
  const result = await db.getBundles({
    where: { channel, platform },
    limit,
    cursor: after ? { after } : undefined,
  });

  return c.json(result);
});

// -----------------------------------------------------------------------------
// GET /t/:appId/bundles/:bundleId — fetch single
// -----------------------------------------------------------------------------
cliApp.get("/t/:appId/bundles/:bundleId", async (c) => {
  const bundleId = c.req.param("bundleId");
  if (!bundleId) {
    return c.json({ error: "Missing bundleId." }, 400);
  }

  const db = dbFactory();
  const bundle = await db.getBundleById(bundleId);
  if (!bundle) {
    return c.json({ error: "Bundle not found." }, 404);
  }
  return c.json(bundle);
});

// -----------------------------------------------------------------------------
// PATCH /t/:appId/bundles/:bundleId — partial update
//
// Body: Partial<Bundle> — only the fields you want to change.
// Used for enable/disable, rollout cohort updates, target cohort changes.
// -----------------------------------------------------------------------------
cliApp.patch("/t/:appId/bundles/:bundleId", async (c) => {
  const bundleId = c.req.param("bundleId");
  if (!bundleId) {
    return c.json({ error: "Missing bundleId." }, 400);
  }

  let patch: Partial<Bundle>;
  try {
    patch = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  // Defense in depth: the firebaseDatabase plugin's updateBundle will only
  // touch the bundle if it belongs to the current tenant (enforced by ALS
  // scoping inside the plugin), but reject obvious cross-tenant patches up
  // front for a clearer error message.
  if (patch.id && patch.id !== bundleId) {
    return c.json({ error: "Body id must match URL bundleId." }, 400);
  }

  const db = dbFactory();
  await db.updateBundle(bundleId, patch);
  await db.commitBundle();

  const updated = await db.getBundleById(bundleId);
  return c.json(updated);
});

// -----------------------------------------------------------------------------
// DELETE /t/:appId/bundles/:bundleId — delete
//
// The firebaseDatabase plugin's deleteBundle takes a full Bundle (it needs
// the storageUri to also clean up bytes), so we fetch first then delete.
// -----------------------------------------------------------------------------
cliApp.delete("/t/:appId/bundles/:bundleId", async (c) => {
  const bundleId = c.req.param("bundleId");
  if (!bundleId) {
    return c.json({ error: "Missing bundleId." }, 400);
  }

  const db = dbFactory();
  const bundle = await db.getBundleById(bundleId);
  if (!bundle) {
    return c.json({ error: "Bundle not found." }, 404);
  }

  await db.deleteBundle(bundle);
  await db.commitBundle();

  return c.json({ deleted: bundleId });
});

// -----------------------------------------------------------------------------
// GET /t/:appId/channels — list distinct channels
// -----------------------------------------------------------------------------
cliApp.get("/t/:appId/channels", async (c) => {
  const db = dbFactory();
  const channels = await db.getChannels();
  return c.json({ channels });
});

export { cliApp };
