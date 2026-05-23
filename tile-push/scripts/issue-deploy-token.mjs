#!/usr/bin/env node
// Issue a new deploy token for a tile-push tenant.
//
//   node issue-deploy-token.mjs <appId> [label]
//
// Writes a SHA-256 hash of a freshly-generated token to
//   tenants/{appId}/deployTokens
// and prints the raw token ONCE so the operator can hand it to the user.
//
// Requires firebase-admin reachable on disk (run from the deploy directory
// where `npm install` has been run), and Google Application Default
// Credentials configured (`gcloud auth application-default login`).
//
// Auth model is documented in plugins/firebase/firebase/functions/cliAuth.ts.

import { createHash, randomBytes } from "node:crypto";

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

const PROJECT_ID = "apptile-staging-setup";
const STORAGE_BUCKET = "tile-push-bundles";
const DATABASE_NAME = "tile-push";

const [, , appId, label = "default"] = process.argv;
if (!appId) {
  console.error("Usage: node issue-deploy-token.mjs <appId> [label]");
  process.exit(1);
}
if (!/^tk_[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/.test(appId)) {
  console.error(`Invalid appId format: ${appId}`);
  process.exit(1);
}

admin.initializeApp({
  projectId: PROJECT_ID,
  storageBucket: STORAGE_BUCKET,
});

const db = getFirestore(admin.app(), DATABASE_NAME);
const ref = db.collection("tenants").doc(appId);

// Token format: tpd_<32 url-safe random bytes>. The leading prefix lets
// support tools recognise these in logs without needing the database.
const rawToken = `tpd_${randomBytes(24).toString("base64url")}`;
const hash = createHash("sha256").update(rawToken).digest("hex");
const now = admin.firestore.Timestamp.now();

const snap = await ref.get();
const tenantName = snap.exists ? (snap.data()?.name ?? appId) : appId;

await ref.set(
  {
    name: tenantName,
    deployTokens: admin.firestore.FieldValue.arrayUnion({
      hash,
      label,
      createdAt: now,
      lastUsedAt: null,
    }),
  },
  { merge: true },
);

console.log("=== Deploy token issued ===");
console.log(`Tenant : ${appId}`);
console.log(`Label  : ${label}`);
console.log(`Token  : ${rawToken}`);
console.log("");
console.log("Save this token immediately — it is only printed once.");
console.log("On the customer machine, either:");
console.log(`  tile-push init    # interactive`);
console.log(`  export TILE_PUSH_APP_ID=${appId}`);
console.log(`  export TILE_PUSH_TOKEN=${rawToken}`);

process.exit(0);
