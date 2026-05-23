import type { Bundle } from "@hot-updater/core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import type {
  DatabaseBundleQueryOptions,
  Paginated,
} from "@hot-updater/plugin-core";

import { TilePushClient } from "../auth/apiClient";

/**
 * Tile Push database plugin.
 *
 * Built on top of `createDatabasePlugin`, which gives us:
 *   - automatic buffering of appendBundle / updateBundle / deleteBundle
 *     into a per-instance changedMap
 *   - one commitBundle({changedSets}) call to our factory, which we ship
 *     to the server in a single POST
 *
 * Reads (getBundleById, getBundles, getChannels) pass through directly to
 * the matching server route. Writes batch through commitBundle.
 */

export interface TilePushDatabaseConfig {
  /**
   * Tenant id. Falls back to the credentials store / env vars if omitted.
   * Strongly recommended to pass explicitly so deploys don't accidentally
   * write to the wrong tenant when multiple are configured locally.
   */
  appId?: string;
  /** API base URL override. Defaults to the credentials store / env value. */
  apiUrl?: string;
}

interface ChangedSet {
  operation: "insert" | "update" | "delete";
  data: Bundle;
}

export const tilePushDatabase = createDatabasePlugin<TilePushDatabaseConfig>({
  name: "tilePushDatabase",
  factory: (_config) => {
    // Lazy client construction. See storage.ts for rationale.
    let cachedClient: Promise<TilePushClient> | null = null;
    const getClient = () =>
      (cachedClient ??= TilePushClient.create());

    return {
      // We let hot-updater's createDatabasePlugin do legacy cursor fallback
      // for us — it's a small payload and the server's cursor support is
      // basic. Set to false (default) for simplicity.
      supportsCursorPagination: false,

      async getBundleById(bundleId: string) {
        const client = await getClient();
        try {
          return await client.get<Bundle | null>(
            `/bundles/${encodeURIComponent(bundleId)}`,
          );
        } catch (err) {
          // Server returns 404 if missing — match the contract by returning null
          if (
            typeof err === "object" &&
            err !== null &&
            "status" in err &&
            (err as { status: number }).status === 404
          ) {
            return null;
          }
          throw err;
        }
      },

      async getBundles(options: DatabaseBundleQueryOptions & { offset?: number }) {
        const client = await getClient();
        const params = new URLSearchParams();
        params.set("limit", String(options.limit));
        if (options.where?.channel)
          params.set("channel", options.where.channel);
        if (options.where?.platform)
          params.set("platform", options.where.platform);
        if (options.cursor?.after) params.set("after", options.cursor.after);
        return client.get<Paginated<Bundle[]>>(`/bundles?${params}`);
      },

      async getChannels() {
        const client = await getClient();
        const { channels } = await client.get<{ channels: string[] }>(
          "/channels",
        );
        return channels;
      },

      async commitBundle({ changedSets }: { changedSets: ChangedSet[] }) {
        if (changedSets.length === 0) return;
        const client = await getClient();
        await client.post("/bundles", {
          json: { changedSets },
        });
      },
    };
  },
});

export type TilePushDatabasePlugin = ReturnType<
  ReturnType<typeof tilePushDatabase>
>;
