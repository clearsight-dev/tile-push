import type { Bundle, Platform } from "@hot-updater/plugin-core";
import admin from "firebase-admin";
import { Hono } from "hono";

import { firebaseDatabase } from "../../src/firebaseDatabase";
import { cliAuthMiddleware, getCliAuth } from "./cliAuth";

// -----------------------------------------------------------------------------
// Cloud CDN cache invalidation on deploy
//
// After a successful bundle commit we call urlMaps.invalidateCache scoped to
// the tenant's check-update prefix. Cache TTL is 30 days; explicit
// invalidation is what gives us instant rollout while still serving the rest
// of the time from edge.
//
// Failure here must NOT fail the deploy — the bundle is already in Firestore
// at this point. Worst case the cache serves stale for up to s-maxage, which
// is bounded recovery, not a correctness failure.
//
// We pull the access token from the GCE metadata server rather than pulling
// in google-auth-library — Cloud Run instances always have metadata available,
// and the service account's default scopes already cover the Compute API
// (roles/editor → compute.urlMaps.invalidateCache).
// -----------------------------------------------------------------------------
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "apptile-staging-setup";
const URL_MAP_NAME = process.env.HOT_UPDATER_URL_MAP ?? "tile-push-lb";

async function getMetadataAccessToken(): Promise<string> {
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) {
    throw new Error(
      `metadata server returned ${response.status}: ${await response.text()}`,
    );
  }
  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

async function invalidateTenantCache(appId: string): Promise<void> {
  try {
    const token = await getMetadataAccessToken();
    const response = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${PROJECT_ID}/global/urlMaps/${URL_MAP_NAME}/invalidateCache`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: `/api/check-update/v2/t/${appId}/*`,
        }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      console.error(
        `[cdn] invalidation failed for ${appId}: HTTP ${response.status} ${text}`,
      );
      return;
    }
    const data = (await response.json()) as { name?: string; status?: string };
    console.log(
      `[cdn] invalidated /api/check-update/v2/t/${appId}/* op=${data.name} status=${data.status}`,
    );
  } catch (err) {
    console.error(
      `[cdn] invalidation error for ${appId}:`,
      (err as Error).message,
    );
  }
}

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
// Download URLs are used by the deploy-time patch generator to pull previous
// bundle bytes for hdiff. Deploy fetches immediately; no reason to grant a
// long replay window.
const DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000; // 5m
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

  // Bundle artifacts are content-addressed (bundle ID is a UUIDv7, the URL
  // never serves different bytes for the same path), so we set them
  // immutable for a year on the object itself. Cloud CDN reads this header
  // and caches at the edge forever; browsers/devices skip revalidation.
  const cacheControl = "public, max-age=31536000, immutable";

  const bucket = admin.storage().bucket(STORAGE_BUCKET);
  const file = bucket.file(scopedKey);

  const [uploadUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + UPLOAD_URL_TTL_MS,
    contentType,
    extensionHeaders: {
      "x-goog-content-length-range": `0,${MAX_UPLOAD_SIZE_BYTES}`,
      "Cache-Control": cacheControl,
    },
  });

  return c.json({
    uploadUrl,
    storageUri: `gs://${STORAGE_BUCKET}/${scopedKey}`,
    requiredHeaders: {
      "Content-Type": contentType,
      "x-goog-content-length-range": `0,${MAX_UPLOAD_SIZE_BYTES}`,
      "Cache-Control": cacheControl,
    },
  });
});

// -----------------------------------------------------------------------------
// GET /t/:appId/storage/download-url?uri=gs://... — signed GCS GET URL
//
// Used by the deploy-time patch generator: hot-updater's createBundleDiff
// downloads previous bundle bytes (manifests + .bundle files) on the deploy
// machine, runs hdiff WASM locally, and uploads the resulting .bsdiff patch
// via the existing upload-url flow.
//
// Security: the `uri` MUST start with gs://tile-push-bundles/t/{appId}/ for
// the authenticated appId. Without this prefix check a deploy token holder
// could pull other tenants' bundles. The signed URL has a 5-minute TTL — the
// CLI fetches immediately, so a long window has no use beyond replay surface.
// -----------------------------------------------------------------------------
cliApp.get("/t/:appId/storage/download-url", async (c) => {
  const auth = getCliAuth(c);
  const uri = c.req.query("uri");
  if (!uri) {
    return c.json({ error: "Missing required query param: uri." }, 400);
  }

  // Parse gs://{bucket}/{key} and enforce tenant scoping on the key prefix.
  const expectedPrefix = `gs://${STORAGE_BUCKET}/t/${auth.appId}/`;
  if (!uri.startsWith(expectedPrefix)) {
    return c.json(
      {
        error:
          "Invalid uri: must begin with gs://tile-push-bundles/t/{your-appId}/",
      },
      400,
    );
  }
  const objectKey = uri.slice(`gs://${STORAGE_BUCKET}/`.length);
  if (objectKey.includes("..")) {
    return c.json({ error: "Invalid uri: path traversal not allowed." }, 400);
  }

  const bucket = admin.storage().bucket(STORAGE_BUCKET);
  const file = bucket.file(objectKey);
  const [exists] = await file.exists();
  if (!exists) {
    return c.json({ error: "Object not found." }, 404);
  }

  const [downloadUrl] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + DOWNLOAD_URL_TTL_MS,
  });

  return c.json({ downloadUrl });
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

  // Invalidate the tenant's CDN cache for check-update so devices see the new
  // bundle on their next request instead of waiting for s-maxage to expire.
  // Fire-and-await — we want the deploy response to wait for invalidation so
  // CLI users know when devices will pick up the new bundle.
  const appId = c.req.param("appId") ?? getCliAuth(c).appId;
  await invalidateTenantCache(appId);

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
