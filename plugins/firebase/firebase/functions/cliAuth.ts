import { createHash } from "node:crypto";

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import type { MiddlewareHandler } from "hono";

import { isValidAppId, tenantALS } from "../../src/tenantContext";

// The fork uses a named Firestore database "tile-push" (NOT (default)).
// firebaseDatabase.ts is wired to talk to it; this middleware must too,
// otherwise tenant doc lookups will silently miss the right collection.
const FIRESTORE_DATABASE_NAME = "tile-push";

/**
 * Tenant doc shape in Firestore.
 *
 *   tenants/{appId}
 *     name: "Acme App"
 *     deployTokens: [
 *       { hash: "<sha256 of token>", label: "ci", createdAt, lastUsedAt },
 *       ...
 *     ]
 *
 * Tokens are stored as SHA-256 hashes — we never persist the raw token. The
 * CLI sends the raw token in `Authorization: Bearer ...` and we hash it on
 * every request to compare. Adding new tokens means writing a new {hash}
 * entry; revoking means deleting one.
 */
interface DeployTokenEntry {
  hash: string;
  label?: string;
  createdAt?: FirebaseFirestore.Timestamp;
  lastUsedAt?: FirebaseFirestore.Timestamp;
}

interface TenantDoc {
  name?: string;
  deployTokens?: DeployTokenEntry[];
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const extractBearerToken = (header: string | undefined): string | null => {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

export interface CliAuthContext {
  appId: string;
  tenantName: string;
  tokenLabel: string;
}

/**
 * Hono middleware that authenticates CLI requests.
 *
 * 1. Pulls `appId` from the URL param (`:appId`)
 * 2. Reads Bearer token from Authorization header
 * 3. Hashes token, compares against tenants/{appId}/deployTokens[].hash
 * 4. On match: sets ALS context, attaches CliAuthContext to Hono context,
 *    invokes next() inside tenantALS.run so all downstream firebase plugin
 *    calls automatically resolve the right appId.
 * 5. On miss: returns 401 (or 400 for malformed inputs).
 *
 * Note: lastUsedAt is updated as a fire-and-forget write so it doesn't add
 * latency to the request. Failures to update are logged but not surfaced.
 */
export const cliAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const appId = c.req.param("appId");
  if (!appId || !isValidAppId(appId)) {
    return c.json(
      {
        error:
          "Invalid appId. Expected format: tk_<lowercase-alphanumeric-with-hyphens>.",
      },
      400,
    );
  }

  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) {
    return c.json(
      { error: "Missing Authorization: Bearer <token> header." },
      401,
    );
  }

  const db = getFirestore(admin.app(), FIRESTORE_DATABASE_NAME);
  const tenantRef = db.collection("tenants").doc(appId);
  const snap = await tenantRef.get();
  if (!snap.exists) {
    return c.json({ error: "Unknown tenant." }, 401);
  }

  const data = snap.data() as TenantDoc;
  const tokenHash = hashToken(token);
  const match = data.deployTokens?.find((entry) => entry.hash === tokenHash);
  if (!match) {
    return c.json({ error: "Invalid token." }, 401);
  }

  // Fire-and-forget lastUsedAt bump. Use arrayRemove+arrayUnion to update the
  // single matching entry without rewriting the entire array.
  const updatedEntry: DeployTokenEntry = {
    ...match,
    lastUsedAt: new Date() as unknown as FirebaseFirestore.Timestamp,
  };
  tenantRef
    .update({
      deployTokens: [
        ...(data.deployTokens?.filter((e) => e.hash !== tokenHash) ?? []),
        updatedEntry,
      ],
    })
    .catch((err) => {
      console.warn("[cliAuth] failed to update lastUsedAt", err);
    });

  const authContext: CliAuthContext = {
    appId,
    tenantName: data.name ?? appId,
    tokenLabel: match.label ?? "unlabeled",
  };
  c.set("cliAuth", authContext);

  // Run downstream in ALS context so firebaseDatabase / firebaseStorage
  // automatically scope reads/writes to this tenant.
  return tenantALS.run({ appId }, () => next());
};

/**
 * Helper to pull the auth context out of a Hono handler. Throws if the
 * middleware wasn't applied — programmer error.
 */
export const getCliAuth = (c: {
  get: (key: "cliAuth") => CliAuthContext | undefined;
}): CliAuthContext => {
  const auth = c.get("cliAuth");
  if (!auth) {
    throw new Error(
      "cliAuth context missing — did you forget to apply cliAuthMiddleware?",
    );
  }
  return auth;
};
