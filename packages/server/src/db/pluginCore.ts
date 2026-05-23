import type {
  AppUpdateAvailableInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  Platform,
  UpdateInfo,
} from "@hot-updater/core";
import {
  getRolledOutNumericCohorts,
  isCohortEligibleForUpdate,
  NIL_UUID,
  NUMERIC_COHORT_SIZE,
  normalizeRolloutCohortCount,
} from "@hot-updater/core";
import {
  type DatabaseBundleQueryOptions,
  type DatabaseBundleQueryOrder,
  type DatabaseBundleQueryWhere,
  type DatabasePlugin,
  type HotUpdaterContext,
  semverSatisfies,
} from "@hot-updater/plugin-core";

import { assertBundlePersistenceConstraints } from "./schemaEnhancements";
import type {
  AppUpdateCandidate,
  AppUpdateCandidatesResponse,
  DatabaseAPI,
} from "./types";
import { resolveManifestArtifacts } from "./updateArtifacts";

const PAGE_SIZE = 100;
const DESC_ORDER = { field: "id", direction: "desc" } as const;

// Cohort set that always passes the client picker's eligibility test —
// attached to ROLLBACK candidates so the client treats them as universally
// eligible, mirroring v1's "rollback ignores cohort" behavior.
const ALL_NUMERIC_COHORTS: number[] = Array.from(
  { length: NUMERIC_COHORT_SIZE },
  (_, i) => i + 1,
);

const bundleMatchesQueryWhere = (
  bundle: Bundle,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  if (!where) return true;
  if (where.channel !== undefined && bundle.channel !== where.channel)
    return false;
  if (where.platform !== undefined && bundle.platform !== where.platform)
    return false;
  if (where.enabled !== undefined && bundle.enabled !== where.enabled)
    return false;
  if (where.id?.eq !== undefined && bundle.id !== where.id.eq) return false;
  if (where.id?.gt !== undefined && bundle.id.localeCompare(where.id.gt) <= 0)
    return false;
  if (where.id?.gte !== undefined && bundle.id.localeCompare(where.id.gte) < 0)
    return false;
  if (where.id?.lt !== undefined && bundle.id.localeCompare(where.id.lt) >= 0)
    return false;
  if (where.id?.lte !== undefined && bundle.id.localeCompare(where.id.lte) > 0)
    return false;
  if (where.id?.in && !where.id.in.includes(bundle.id)) return false;
  if (where.targetAppVersionNotNull && bundle.targetAppVersion === null) {
    return false;
  }
  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  ) {
    return false;
  }
  if (
    where.targetAppVersionIn &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  return true;
};

const sortBundles = (
  bundles: Bundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
) => {
  const direction = orderBy?.direction ?? "desc";
  return bundles.slice().sort((a, b) => {
    const result = a.id.localeCompare(b.id);
    return direction === "asc" ? result : -result;
  });
};

const makeResponse = (
  bundle: Bundle,
  status: "UPDATE" | "ROLLBACK",
): UpdateInfo => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
  storageUri: bundle.storageUri,
  fileHash: bundle.fileHash,
});

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  message: null,
  id: NIL_UUID,
  shouldForceUpdate: true,
  status: "ROLLBACK",
  storageUri: null,
  fileHash: null,
};

export function createPluginDatabaseCore<TContext = unknown>(
  getPlugin: () => DatabasePlugin<TContext>,
  resolveFileUrl: (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string | null>,
  options?: {
    createMutationPlugin?: () => DatabasePlugin<TContext>;
    cleanupMutationPlugin?: (
      plugin: DatabasePlugin<TContext>,
    ) => Promise<void> | void;
    readStorageText?: (
      storageUri: string,
      context?: HotUpdaterContext<TContext>,
    ) => Promise<string | null>;
  },
): {
  api: DatabaseAPI<TContext>;
  adapterName: string;
  createMigrator: () => never;
  generateSchema: () => never;
} {
  const runWithMutationPlugin = async <T>(
    operation: (plugin: DatabasePlugin<TContext>) => Promise<T>,
  ): Promise<T> => {
    const plugin = options?.createMutationPlugin?.() ?? getPlugin();

    try {
      return await operation(plugin);
    } finally {
      if (options?.createMutationPlugin) {
        await options.cleanupMutationPlugin?.(plugin);
      }
    }
  };

  const getSortedBundlePage = async (
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TContext>,
  ): Promise<Awaited<ReturnType<DatabasePlugin<TContext>["getBundles"]>>> => {
    const result = await getPlugin().getBundles(
      {
        ...options,
        orderBy: options.orderBy ?? DESC_ORDER,
      },
      context,
    );

    return {
      ...result,
      data: sortBundles(result.data, options.orderBy ?? DESC_ORDER),
    };
  };

  const isEligibleForUpdate = (
    bundle: Bundle,
    cohort: string | undefined,
  ): boolean => {
    return isCohortEligibleForUpdate(
      bundle.id,
      cohort,
      bundle.rolloutCohortCount,
      bundle.targetCohorts,
    );
  };

  // Collects all bundles that match the candidate filter (platform, channel,
  // fingerprint / app-version), regardless of cohort. Used by the v2
  // candidates endpoint where the client picks based on its local cohort.
  const findAllCandidatesByScanning = async ({
    queryWhere,
    isCandidate,
    context,
  }: {
    queryWhere: DatabaseBundleQueryWhere;
    isCandidate: (bundle: Bundle) => boolean;
    context?: HotUpdaterContext<TContext>;
  }): Promise<Bundle[]> => {
    const collected: Bundle[] = [];
    let after: string | undefined;

    while (true) {
      const { data, pagination } = await getSortedBundlePage(
        {
          where: queryWhere,
          limit: PAGE_SIZE,
          orderBy: DESC_ORDER,
          ...(after
            ? {
                cursor: {
                  after,
                },
              }
            : {}),
        },
        context,
      );

      for (const bundle of data) {
        if (
          !bundleMatchesQueryWhere(bundle, queryWhere) ||
          !isCandidate(bundle)
        ) {
          continue;
        }
        collected.push(bundle);
      }

      if (!pagination.hasNextPage) {
        break;
      }

      after = data.at(-1)?.id;
      if (!after) {
        break;
      }
    }

    return collected;
  };

  const findUpdateInfoByScanning = async ({
    args,
    queryWhere,
    isCandidate,
    context,
  }: {
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs;
    queryWhere: DatabaseBundleQueryWhere;
    isCandidate: (bundle: Bundle) => boolean;
    context?: HotUpdaterContext<TContext>;
  }): Promise<UpdateInfo | null> => {
    let after: string | undefined;

    while (true) {
      const { data, pagination } = await getSortedBundlePage(
        {
          where: queryWhere,
          limit: PAGE_SIZE,
          orderBy: DESC_ORDER,
          ...(after
            ? {
                cursor: {
                  after,
                },
              }
            : {}),
        },
        context,
      );

      for (const bundle of data) {
        if (
          !bundleMatchesQueryWhere(bundle, queryWhere) ||
          !isCandidate(bundle)
        ) {
          continue;
        }

        if (args.bundleId === NIL_UUID) {
          if (isEligibleForUpdate(bundle, args.cohort)) {
            return makeResponse(bundle, "UPDATE");
          }
          continue;
        }

        const compareResult = bundle.id.localeCompare(args.bundleId);

        if (compareResult > 0) {
          if (isEligibleForUpdate(bundle, args.cohort)) {
            return makeResponse(bundle, "UPDATE");
          }
          continue;
        }

        if (compareResult === 0) {
          if (isEligibleForUpdate(bundle, args.cohort)) {
            return null;
          }
          continue;
        }

        return makeResponse(bundle, "ROLLBACK");
      }

      if (!pagination.hasNextPage) {
        break;
      }

      after = data.at(-1)?.id;
      if (!after) {
        break;
      }
    }

    if (args.bundleId === NIL_UUID) {
      return null;
    }

    if (
      args.minBundleId &&
      args.bundleId.localeCompare(args.minBundleId) <= 0
    ) {
      return null;
    }

    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  };

  const getBaseWhere = ({
    platform,
    channel,
    minBundleId,
  }: {
    platform: Platform;
    channel: string;
    minBundleId: string;
  }): DatabaseBundleQueryWhere => ({
    platform,
    channel,
    enabled: true,
    id: {
      gte: minBundleId,
    },
  });

  const api: DatabaseAPI<TContext> = {
    async getBundleById(
      id: string,
      context?: HotUpdaterContext<TContext>,
    ): Promise<Bundle | null> {
      return getPlugin().getBundleById(id, context);
    },

    async getUpdateInfo(
      args: GetBundlesArgs,
      context?: HotUpdaterContext<TContext>,
    ): Promise<UpdateInfo | null> {
      const plugin = getPlugin();
      const directGetUpdateInfo = plugin.getUpdateInfo;
      if (directGetUpdateInfo) {
        return context === undefined
          ? await directGetUpdateInfo(args)
          : await directGetUpdateInfo(args, context);
      }

      const channel = args.channel ?? "production";
      const minBundleId = args.minBundleId ?? NIL_UUID;
      const baseWhere = getBaseWhere({
        platform: args.platform,
        channel,
        minBundleId,
      });

      if (args._updateStrategy === "fingerprint") {
        return findUpdateInfoByScanning({
          args,
          queryWhere: {
            ...baseWhere,
            fingerprintHash: args.fingerprintHash,
          },
          context,
          isCandidate: (bundle) => {
            return (
              bundle.enabled &&
              bundle.platform === args.platform &&
              bundle.channel === channel &&
              bundle.id.localeCompare(minBundleId) >= 0 &&
              bundle.fingerprintHash === args.fingerprintHash
            );
          },
        });
      }

      return findUpdateInfoByScanning({
        args,
        queryWhere: {
          ...baseWhere,
        },
        context,
        isCandidate: (bundle) => {
          return (
            bundle.enabled &&
            bundle.platform === args.platform &&
            bundle.channel === channel &&
            bundle.id.localeCompare(minBundleId) >= 0 &&
            !!bundle.targetAppVersion &&
            semverSatisfies(bundle.targetAppVersion, args.appVersion)
          );
        },
      });
    },

    async getAppUpdateInfo(
      args: GetBundlesArgs,
      context?: HotUpdaterContext<TContext>,
    ): Promise<AppUpdateAvailableInfo | null> {
      const info = await this.getUpdateInfo(args, context);
      if (!info) {
        return null;
      }
      const { storageUri, ...rest } = info as UpdateInfo & {
        storageUri: string | null;
      };

      const readStorageText = options?.readStorageText;
      if (info.id === NIL_UUID || !readStorageText) {
        const fileUrl = await resolveFileUrl(storageUri ?? null, context);
        const baseResponse: AppUpdateAvailableInfo = { ...rest, fileUrl };
        return baseResponse;
      }

      const [fileUrl, targetBundle, currentBundle] = await Promise.all([
        resolveFileUrl(storageUri ?? null, context),
        getPlugin().getBundleById(info.id, context),
        args.bundleId !== NIL_UUID
          ? getPlugin().getBundleById(args.bundleId, context)
          : null,
      ]);
      const baseResponse: AppUpdateAvailableInfo = { ...rest, fileUrl };
      const manifestArtifacts = await resolveManifestArtifacts({
        currentBundle,
        resolveFileUrl,
        readStorageText,
        targetBundle,
        context,
      });
      if (!manifestArtifacts) {
        return baseResponse;
      }

      return {
        ...baseResponse,
        ...manifestArtifacts,
      };
    },

    async getAppUpdateCandidates(
      args: GetBundlesArgs,
      context?: HotUpdaterContext<TContext>,
    ): Promise<AppUpdateCandidatesResponse> {
      // ─────────────────────────────────────────────────────────────────────
      // v2 candidates: mirror v1's `findUpdateInfoByScanning` walk structure,
      // but DO NOT filter by cohort eligibility (that moves to the client).
      // Tag each bundle with its v1-equivalent status, short-circuit on the
      // first older bundle (ROLLBACK target), and append the same after-loop
      // INIT_BUNDLE_ROLLBACK that v1 emits — under the same gating
      // conditions. The client picker becomes a trivial cohort filter.
      //
      // Each candidate carries `eligibleNumericCohorts` + `targetCohorts`.
      // ROLLBACK candidates (real older or synthetic init-rollback) are
      // marked always-eligible to mirror v1's "no cohort check on rollback"
      // behavior.
      // ─────────────────────────────────────────────────────────────────────
      const channel = args.channel ?? "production";
      const minBundleId = args.minBundleId ?? NIL_UUID;
      const currentBundleId = args.bundleId ?? NIL_UUID;
      const baseWhere = getBaseWhere({
        platform: args.platform,
        channel,
        minBundleId,
      });

      const queryWhere: DatabaseBundleQueryWhere =
        args._updateStrategy === "fingerprint"
          ? { ...baseWhere, fingerprintHash: args.fingerprintHash }
          : baseWhere;

      const isCandidate = (bundle: Bundle): boolean => {
        if (
          !bundle.enabled ||
          bundle.platform !== args.platform ||
          bundle.channel !== channel ||
          bundle.id.localeCompare(minBundleId) < 0
        ) {
          return false;
        }
        if (args._updateStrategy === "fingerprint") {
          return bundle.fingerprintHash === args.fingerprintHash;
        }
        return (
          !!bundle.targetAppVersion &&
          semverSatisfies(bundle.targetAppVersion, args.appVersion)
        );
      };

      // Walk DESC, bucket each bundle. Short-circuits on first older bundle.
      type Tagged = {
        bundle: Bundle;
        status: "UPDATE" | "ROLLBACK";
        alwaysEligible: boolean;
      };
      const tagged: Tagged[] = [];
      let stop = false;
      let after: string | undefined;

      while (!stop) {
        const { data, pagination } = await getSortedBundlePage(
          {
            where: queryWhere,
            limit: PAGE_SIZE,
            orderBy: DESC_ORDER,
            ...(after ? { cursor: { after } } : {}),
          },
          context,
        );

        for (const bundle of data) {
          if (
            !bundleMatchesQueryWhere(bundle, queryWhere) ||
            !isCandidate(bundle)
          ) {
            continue;
          }

          if (currentBundleId === NIL_UUID) {
            // Fresh install: every bundle is a potential upgrade.
            tagged.push({ bundle, status: "UPDATE", alwaysEligible: false });
            continue;
          }

          const cmp = bundle.id.localeCompare(currentBundleId);

          if (cmp > 0) {
            tagged.push({ bundle, status: "UPDATE", alwaysEligible: false });
            continue;
          }
          if (cmp === 0) {
            // Current bundle. Tagged UPDATE; client picker returns null when
            // `picked.id === currentBundleId` so SDK no-ops on this case.
            tagged.push({ bundle, status: "UPDATE", alwaysEligible: false });
            continue;
          }
          // cmp < 0 — first bundle older than current; ROLLBACK target.
          // v1 returns this without a cohort check, so we mark it
          // always-eligible and stop scanning (mirroring v1 short-circuit).
          tagged.push({ bundle, status: "ROLLBACK", alwaysEligible: true });
          stop = true;
          break;
        }

        if (stop || !pagination.hasNextPage) break;
        after = data.at(-1)?.id;
        if (!after) break;
      }

      // Enrich each tagged bundle into AppUpdateCandidate (preserve the
      // existing manifest/fileUrl/cohort logic from the original v2 impl).
      const readStorageText = options?.readStorageText;
      const currentBundle =
        args.bundleId && args.bundleId !== NIL_UUID
          ? await getPlugin().getBundleById(args.bundleId, context)
          : null;

      const candidates: AppUpdateCandidate[] = await Promise.all(
        tagged.map(async ({ bundle, status, alwaysEligible }) => {
          const baseInfo = makeResponse(bundle, status);
          const { storageUri, ...rest } = baseInfo as UpdateInfo & {
            storageUri: string | null;
          };

          const fileUrl = await resolveFileUrl(storageUri ?? null, context);
          const baseResponse: AppUpdateAvailableInfo = { ...rest, fileUrl };

          let enriched: AppUpdateAvailableInfo = baseResponse;
          if (readStorageText) {
            const manifestArtifacts = await resolveManifestArtifacts({
              currentBundle,
              resolveFileUrl,
              readStorageText,
              targetBundle: bundle,
              context,
            });
            if (manifestArtifacts) {
              enriched = { ...baseResponse, ...manifestArtifacts };
            }
          }

          const normalizedRolloutCount = normalizeRolloutCohortCount(
            bundle.rolloutCohortCount,
          );
          const eligibleNumericCohorts = alwaysEligible
            ? ALL_NUMERIC_COHORTS
            : getRolledOutNumericCohorts(
                bundle.id,
                bundle.rolloutCohortCount,
              );

          return {
            ...enriched,
            rolloutCohortCount: normalizedRolloutCount,
            targetCohorts: alwaysEligible
              ? []
              : (bundle.targetCohorts ?? []),
            eligibleNumericCohorts,
          };
        }),
      );

      // Append INIT_BUNDLE_ROLLBACK synthetic ONLY under v1's gating —
      // NOT for fresh installs (NIL_UUID), NOT when current is below
      // minBundleId. v1 returns null in those cases; we mirror by simply
      // not emitting the synthetic.
      if (
        currentBundleId !== NIL_UUID &&
        currentBundleId.localeCompare(minBundleId) > 0
      ) {
        candidates.push({
          message: null,
          id: NIL_UUID,
          shouldForceUpdate: true,
          status: "ROLLBACK",
          fileHash: null,
          fileUrl: null,
          rolloutCohortCount: NUMERIC_COHORT_SIZE,
          targetCohorts: [],
          eligibleNumericCohorts: ALL_NUMERIC_COHORTS,
        } as AppUpdateCandidate);
      }

      return { candidates };
    },

    async getChannels(
      context?: HotUpdaterContext<TContext>,
    ): Promise<string[]> {
      return getPlugin().getChannels(context);
    },

    async getBundles(options, context?: HotUpdaterContext<TContext>) {
      return getPlugin().getBundles(options, context);
    },

    async insertBundle(
      bundle: Bundle,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      assertBundlePersistenceConstraints(bundle);
      await runWithMutationPlugin(async (plugin) => {
        await plugin.appendBundle(bundle, context);
        await plugin.commitBundle(context);
      });
    },

    async updateBundleById(
      bundleId: string,
      newBundle: Partial<Bundle>,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await runWithMutationPlugin(async (plugin) => {
        const current = await plugin.getBundleById(bundleId, context);
        if (!current) {
          throw new Error("targetBundleId not found");
        }
        assertBundlePersistenceConstraints({ ...current, ...newBundle });
        await plugin.updateBundle(bundleId, newBundle, context);
        await plugin.commitBundle(context);
      });
    },

    async deleteBundleById(
      bundleId: string,
      context?: HotUpdaterContext<TContext>,
    ): Promise<void> {
      await runWithMutationPlugin(async (plugin) => {
        const bundle = await plugin.getBundleById(bundleId, context);
        if (!bundle) {
          return;
        }
        await plugin.deleteBundle(bundle, context);
        await plugin.commitBundle(context);
      });
    },
  };

  return {
    api,
    adapterName: getPlugin().name,
    createMigrator: () => {
      throw new Error(
        "createMigrator is only available for Kysely/Prisma/Drizzle database adapters.",
      );
    },
    generateSchema: () => {
      throw new Error(
        "generateSchema is only available for Kysely/Prisma/Drizzle database adapters.",
      );
    },
  };
}
