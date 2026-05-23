import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext {
  appId: string;
}

/**
 * Module-level singleton. Stores per-request tenant context.
 * Set at the Cloud Function entry point (firebase/functions/index.ts) and
 * read deep in firebaseDatabase.ts via currentAppId().
 *
 * Concurrency-safe: each Cloud Run request runs in its own async context;
 * stores never bleed across requests.
 */
export const tenantALS = new AsyncLocalStorage<TenantContext>();

/**
 * Format guard. appId is shown in URLs (`/api/check-update/v2/t/{appId}/...`)
 * so it must be URL-safe. Keep it short, prefixed, kebab-case.
 *
 * Examples that pass: tk_acme, tk_acme-prod, tk_smashshop-staging-3
 * Examples that fail: tk_ACME, tk_a (too short), random-without-prefix
 */
const APP_ID_PATTERN = /^tk_[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/;

export function isValidAppId(appId: string): boolean {
  return APP_ID_PATTERN.test(appId);
}

/**
 * Read the current tenant's appId from the async context.
 *
 * Resolution order:
 *   1. AsyncLocalStorage context (set by HTTP middleware) — always wins.
 *   2. The `fallback` argument (typically `config.appId` from the plugin
 *      factory) — used for CLI/script flows that don't have a request.
 *   3. Throw — neither set is an invariant violation.
 *
 * The fallback exists so the CLI (`hot-updater deploy`) can run without
 * setting ALS itself. The user pins `appId` in `hot-updater.config.ts` and
 * the plugin reads it as a default. At runtime (HTTP), the URL-derived ALS
 * value takes precedence.
 */
export function currentAppId(fallback?: string): string {
  const ctx = tenantALS.getStore();
  if (ctx?.appId) return ctx.appId;
  if (fallback) return fallback;
  throw new Error(
    "TENANT_CONTEXT_MISSING: firebaseDatabase received a call without a " +
      "tenant context. HTTP requests must include /t/{appId}/ in the URL. " +
      "CLI/script flows must either wrap calls in tenantALS.run() or set " +
      "`appId` in the plugin config (e.g. firebaseDatabase({ appId: 'tk_...' })).",
  );
}

/**
 * Convenience for callers that need to enter the tenant context explicitly
 * (e.g. CLI deploys, scripts, tests).
 */
export function runWithTenant<T>(
  appId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!isValidAppId(appId)) {
    throw new Error(`Invalid appId format: ${appId}`);
  }
  return Promise.resolve(tenantALS.run({ appId }, fn));
}
