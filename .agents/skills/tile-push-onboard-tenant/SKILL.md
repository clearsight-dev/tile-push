---
name: tile-push-onboard-tenant
description: Use when a new tile-push customer needs deploy credentials issued — picks/validates an appId, generates a Bearer token, writes the Firestore tenant document with the SHA-256 hash, and returns the token (shown only once, can't be recovered). Use any time the user asks to onboard, add, register, or provision a new tenant / appId / customer for tile-push.
---

# Tile Push — Onboard Tenant

Issue deploy credentials for a new tile-push customer. Each tenant gets:
1. An `appId` (format: `tk_<kebab-slug>`)
2. A Bearer token (format: `tpd_<base64>`), shown **once** to the user
3. A Firestore doc at `tenants/{appId}` storing the SHA-256 hash of the token

The plaintext token is given to the customer and never stored. If they lose it, you issue a new one.

## When to use

- "Onboard a new tenant for `<company-name>`"
- "Issue a deploy token for tk_acme"
- "Add a new appId for our customer X"
- "Set up tile-push credentials for <project>"
- "Generate a deploy token"

## When NOT to use

- Renewing an existing customer's token (use a separate token-rotation flow — add a new token to the array, don't replace).
- Setting up the LOCAL credentials file on a developer machine — that's `tile-push init`, separate from this server-side onboarding.

## Workflow

### 1. Confirm the appId

Ask the user for an appId if they didn't provide one. Format rules (enforced by `isValidAppId` in [`plugins/firebase/src/tenantContext.ts`](../../../plugins/firebase/src/tenantContext.ts)):

- Prefix: `tk_`
- Body: lowercase alphanumeric + hyphens
- Length: 6-43 chars total (`tk_` + 3-40 body chars)
- Must start and end with alphanumeric (no leading/trailing hyphens)

Good examples: `tk_acme`, `tk_acme-prod`, `tk_my-customer-name-123`
Bad: `tk_ACME` (uppercase), `tk_-acme` (leading hyphen), `tk_a` (too short)

If the user proposes a name with invalid chars, suggest a corrected slug. Don't silently fix — confirm with them.

### 2. Check the appId isn't already taken

```bash
gcloud firestore documents describe tenants/{appId} --database=tile-push 2>&1 | head -5
```

If the doc exists → tenant is already onboarded. **Don't overwrite.** Ask the user if they want to rotate the token (different flow) or pick a different appId.

### 3. Generate a token

Use a cryptographically random 32-byte string, base64-encoded, prefixed with `tpd_`:

```bash
TOKEN="tpd_$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
HASH=$(echo -n "$TOKEN" | shasum -a 256 | awk '{print $1}')
echo "Token:   $TOKEN"
echo "SHA-256: $HASH"
```

**Save the token output** — you'll show this to the user at the end and won't be able to recover it later.

### 4. Write the Firestore tenant document

Find the existing scripts for tenant creation under [`/Users/yaswantha/hot-updater/scripts/`](../../../scripts/) or [`/Users/yaswantha/hot-updater/plugins/firebase/scripts/`](../../../plugins/firebase/scripts/) (search for `issue-token` or `onboard`).

If a script exists, use it. If not, write the document directly via Node script using firebase-admin:

```javascript
// scripts/onboard-tenant.mjs (example)
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

admin.initializeApp({ projectId: "apptile-staging-setup" });
const db = getFirestore(admin.app(), "tile-push");

const appId = process.argv[2];
const tokenHash = process.argv[3];
const tenantName = process.argv[4] ?? appId;
const tokenLabel = process.argv[5] ?? "initial-laptop-token";

await db.collection("tenants").doc(appId).set({
  appId,
  tenantName,
  createdAt: new Date(),
  deployTokens: [
    {
      label: tokenLabel,
      tokenHash,
      createdAt: new Date(),
    },
  ],
});

console.log(`Wrote tenant doc for ${appId}`);
process.exit(0);
```

Run with the GCP service account credentials available (`GOOGLE_APPLICATION_CREDENTIALS` env var pointing at a key file, or `gcloud auth application-default login`).

### 5. Verify the doc was written

```bash
gcloud firestore documents describe tenants/{appId} --database=tile-push --format=json | head -40
```

Confirm:
- `appId` matches
- `deployTokens` is an array with one entry
- `deployTokens[0].tokenHash` matches the SHA-256 you computed
- **No `token` or `plaintext` field exists** — we only store hashes

### 6. Present credentials to the user

Format the output so they can copy-paste:

```
✅ Tenant onboarded.

appId:        tk_acme-prod
token:        tpd_AbCdEfGh1234567890...        ⚠️  SHOWN ONCE — store now
tenant name:  ACME Corp
token label:  initial-laptop-token

To use locally:
  export TILE_PUSH_APP_ID=tk_acme-prod
  export TILE_PUSH_TOKEN=tpd_AbCdEfGh1234567890...

To save in ~/.tile-push/credentials.json (run on the customer's laptop):
  npx tile-push init
  (will prompt for appId + token)
```

Add a clear note that the token cannot be retrieved later — losing it means issuing a new one and revoking the old.

### 7. Test the new credentials work

```bash
curl -H "Authorization: Bearer $TOKEN" https://ota.tile.dev/api/cli/t/{appId}/me
```

Expected:
```json
{"appId": "tk_acme-prod", "tenantName": "ACME Corp", "tokenLabel": "initial-laptop-token"}
```

If 401: token hash didn't match → re-check what you wrote to Firestore. If the doc isn't found → tenant creation failed, retry.

## Token security rules

- **Never log the plaintext token** to Cloud Run logs, CI logs, or persistent storage. It exists only in the user-facing output of this skill.
- **Never store plaintext tokens** in Firestore. Only SHA-256 hashes.
- **The deployTokens field is an array** so a tenant can have multiple active tokens (laptop, CI, second dev, etc.). To rotate: append a new entry, then later remove the old one.
- If a user reports a token leak: revoke immediately by removing that entry from `deployTokens[]` in Firestore. The next request with that token will fail auth.

## Quick reference: relevant entities

| Item | Value |
|---|---|
| Firestore collection | `tenants/` in DB `tile-push` |
| Doc ID | `{appId}` (the tenant's chosen identifier) |
| Auth middleware | [`plugins/firebase/firebase/functions/cliAuth.ts`](../../../plugins/firebase/firebase/functions/cliAuth.ts) |
| Format guard | `isValidAppId` in [`plugins/firebase/src/tenantContext.ts`](../../../plugins/firebase/src/tenantContext.ts) |
| Verify endpoint | `GET /api/cli/t/{appId}/me` |
| API base URL | `https://ota.tile.dev` (primary), `https://apptile-staging-setup.web.app` (fallback) |

## Do not

- Don't accept an appId not matching the `tk_*` regex. Cross-check format before any Firestore write.
- Don't return the plaintext token in any API response (the `/me` endpoint only returns label + appId, never the token).
- Don't overwrite an existing tenant doc. Rotation is a separate operation that appends to `deployTokens[]`.
- Don't store the token plaintext anywhere — even briefly, even in a temp file. It exists only in shell history (which the user should clean up) and the customer's secrets store.
- Don't issue a token without first confirming the appId with the user. Typos here turn into stuck tenants.
