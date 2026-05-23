import { homedir } from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Persistent credential store at ~/.tile-push/credentials.json.
 *
 *   {
 *     "appId": "tk_acme",
 *     "token": "tpd_xxxxxxxxxxxx",
 *     "apiUrl": "https://api.tile-push.app"  // optional override
 *   }
 *
 * Permissions are tightened to 0600 (owner read/write only) on every write.
 * This file is the equivalent of a passwd entry — losing control of it gives
 * an attacker deploy access to the tenant.
 *
 * For env-var overrides (CI machines, scripted use), TILE_PUSH_APP_ID +
 * TILE_PUSH_TOKEN take precedence over whatever's on disk. That way you
 * don't need to write a creds file during CI runs.
 */

export interface TilePushCredentials {
  appId: string;
  token: string;
  apiUrl?: string;
}

const DEFAULT_API_URL = "https://api.tile-push.app";

const credentialsPath = () => join(homedir(), ".tile-push", "credentials.json");
const credentialsDir = () => join(homedir(), ".tile-push");

/**
 * Resolve credentials with env precedence:
 *   1. TILE_PUSH_APP_ID + TILE_PUSH_TOKEN env vars (preferred for CI)
 *   2. ~/.tile-push/credentials.json (interactive / dev machines)
 *   3. null if neither set
 *
 * TILE_PUSH_API_URL overrides the API base URL in either case.
 */
export const loadCredentials = async (): Promise<TilePushCredentials | null> => {
  const envAppId = process.env.TILE_PUSH_APP_ID;
  const envToken = process.env.TILE_PUSH_TOKEN;
  const envApiUrl = process.env.TILE_PUSH_API_URL;

  if (envAppId && envToken) {
    return {
      appId: envAppId,
      token: envToken,
      apiUrl: envApiUrl ?? DEFAULT_API_URL,
    };
  }

  try {
    const raw = await readFile(credentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TilePushCredentials>;
    if (!parsed.appId || !parsed.token) return null;
    return {
      appId: parsed.appId,
      token: parsed.token,
      apiUrl: envApiUrl ?? parsed.apiUrl ?? DEFAULT_API_URL,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

export const saveCredentials = async (
  creds: TilePushCredentials,
): Promise<void> => {
  await mkdir(credentialsDir(), { recursive: true, mode: 0o700 });
  await writeFile(
    credentialsPath(),
    JSON.stringify(creds, null, 2),
    { mode: 0o600 },
  );
};

/**
 * Throws a helpful message if no credentials are configured. Use this at the
 * top of any command that needs server access.
 */
export const requireCredentials = async (): Promise<TilePushCredentials> => {
  const creds = await loadCredentials();
  if (!creds) {
    throw new Error(
      "No Tile Push credentials found. Run `tile-push init` to set up, " +
        "or export TILE_PUSH_APP_ID and TILE_PUSH_TOKEN environment variables.",
    );
  }
  return creds;
};

/** Test helper — confirms creds file exists and is 0600 (or just env vars). */
export const credentialsDiagnostic = async (): Promise<{
  source: "env" | "file" | "none";
  pathOrEnv: string;
  modeOk?: boolean;
}> => {
  if (process.env.TILE_PUSH_APP_ID && process.env.TILE_PUSH_TOKEN) {
    return { source: "env", pathOrEnv: "TILE_PUSH_APP_ID / TILE_PUSH_TOKEN" };
  }
  try {
    const s = await stat(credentialsPath());
    // 0o777 mask gives just the permission bits
    return {
      source: "file",
      pathOrEnv: credentialsPath(),
      modeOk: (s.mode & 0o777) === 0o600,
    };
  } catch {
    return { source: "none", pathOrEnv: credentialsPath() };
  }
};
