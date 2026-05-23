import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestFileHash,
  getManifestStorageUri,
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
  type SnakeCaseBundle,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
  createDatabasePluginGetUpdateInfo,
} from "@hot-updater/plugin-core";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

import { currentAppId } from "./tenantContext";

type FirestoreData = admin.firestore.DocumentData;

// -----------------------------------------------------------------------------
// Tenant-aware internal types
// -----------------------------------------------------------------------------
//
// Bundle (upstream type) has `appId?: string` — optional, because we can't
// break upstream callers. But INSIDE this plugin, every bundle is tenant-
// scoped. These tightened types make the invariant explicit:
//   - TenantBundle: a Bundle that definitely has appId set
//   - TenantSnakeCaseBundle: same, but matches Firestore document shape
//   - TenantQueryWhere: a where clause that has app_id pinned to a value
//
// The plugin uses these internally; callers pass the upstream types and the
// plugin lifts them into the tenant-required shape via currentAppId().
//
// If you add a new method, you'll get a TypeScript error if you try to write
// a bundle without appId or filter without app_id. That's the enforcement.
// -----------------------------------------------------------------------------

type TenantBundle = Bundle & { appId: string };
type TenantSnakeCaseBundle = SnakeCaseBundle & { app_id: string };
type TenantQueryWhere = DatabaseBundleQueryWhere & { appId: string };

// Plugin config = Firebase admin options PLUS an optional appId fallback for
// CLI / script callers that don't have an HTTP-derived ALS context.
export interface FirebaseDatabaseConfig extends admin.AppOptions {
  /**
   * Default tenant scope. Used as a fallback when no ALS context is present
   * (e.g. CLI deploy from hot-updater.config.ts). HTTP requests get appId
   * from the `/t/{appId}/` URL segment, which always wins over this.
   */
  appId?: string;
}

const bundleMatchesQueryWhere = (
  bundle: TenantBundle,
  where: TenantQueryWhere,
) => {
  // Tenant invariant: any bundle reaching this helper is already scoped
  // by appId via the Firestore query. Re-check defensively.
  if (bundle.appId !== where.appId) return false;
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

const applyFirestoreQueryableFilters = (
  query: admin.firestore.Query<FirestoreData>,
  where: TenantQueryWhere,
) => {
  // TENANT GUARD: every Firestore query MUST begin with an app_id filter.
  // This is the single chokepoint that enforces tenant isolation at the
  // database query layer. Composite indexes are (app_id, ...rest) so this
  // filter is the discriminator that selects only the tenant's slice.
  let nextQuery = query.where("app_id", "==", where.appId);

  if (where?.channel) {
    nextQuery = nextQuery.where("channel", "==", where.channel);
  }
  if (where?.platform) {
    nextQuery = nextQuery.where("platform", "==", where.platform);
  }
  if (where?.enabled !== undefined) {
    nextQuery = nextQuery.where("enabled", "==", where.enabled);
  }
  if (where?.fingerprintHash !== undefined && where.fingerprintHash !== null) {
    nextQuery = nextQuery.where(
      "fingerprint_hash",
      "==",
      where.fingerprintHash,
    );
  }
  if (
    where?.targetAppVersion !== undefined &&
    where.targetAppVersion !== null
  ) {
    nextQuery = nextQuery.where(
      "target_app_version",
      "==",
      where.targetAppVersion,
    );
  }
  if (where?.id?.eq) {
    nextQuery = nextQuery.where("id", "==", where.id.eq);
  }
  if (where?.id?.gt) {
    nextQuery = nextQuery.where("id", ">", where.id.gt);
  }
  if (where?.id?.gte) {
    nextQuery = nextQuery.where("id", ">=", where.id.gte);
  }
  if (where?.id?.lt) {
    nextQuery = nextQuery.where("id", "<", where.id.lt);
  }
  if (where?.id?.lte) {
    nextQuery = nextQuery.where("id", "<=", where.id.lte);
  }

  return nextQuery;
};

const requiresInMemoryFiltering = (
  where: DatabaseBundleQueryWhere | undefined,
) => {
  return Boolean(
    where?.id?.in ||
    where?.targetAppVersionIn ||
    where?.targetAppVersionNotNull ||
    where?.targetAppVersion === null ||
    where?.fingerprintHash === null,
  );
};

const chunkValues = <T>(values: T[], size: number) => {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
};

const convertToBundle = (
  firestoreData: SnakeCaseBundle & { app_id?: string },
  expectedAppId: string,
): TenantBundle => {
  // Defense-in-depth: if a bundle document somehow lacks app_id, or has a
  // mismatched app_id, refuse to return it. This protects against bugs
  // (forgot to write app_id during a deploy) and against corruption /
  // mistaken cross-tenant writes.
  const docAppId = firestoreData.app_id;
  if (!docAppId) {
    throw new Error(
      `Bundle ${firestoreData.id} has no app_id — corrupt/legacy data, refusing to serve.`,
    );
  }
  if (docAppId !== expectedAppId) {
    throw new Error(
      `Tenant mismatch: bundle ${firestoreData.id} belongs to ${docAppId}, ` +
        `but request was scoped to ${expectedAppId}. Possible cache poisoning ` +
        `or index leak — investigate.`,
    );
  }

  const rawMetadata = firestoreData.metadata;
  const storedPatches = (
    firestoreData as SnakeCaseBundle & {
      patches?: Bundle["patches"];
    }
  ).patches;
  const patches =
    storedPatches && Array.isArray(storedPatches)
      ? storedPatches
      : getBundlePatches({
          metadata: rawMetadata,
          patchBaseBundleId: firestoreData.patch_base_bundle_id ?? null,
          patchBaseFileHash: firestoreData.patch_base_file_hash ?? null,
          patchFileHash: firestoreData.patch_file_hash ?? null,
          patchStorageUri: firestoreData.patch_storage_uri ?? null,
        });
  const primaryPatch = patches[0] ?? null;

  return {
    appId: docAppId,
    channel: firestoreData.channel,
    enabled: Boolean(firestoreData.enabled),
    shouldForceUpdate: Boolean(firestoreData.should_force_update),
    fileHash: firestoreData.file_hash,
    gitCommitHash: firestoreData.git_commit_hash,
    id: firestoreData.id,
    message: firestoreData.message,
    platform: firestoreData.platform,
    targetAppVersion: firestoreData.target_app_version,
    storageUri: firestoreData.storage_uri,
    fingerprintHash: firestoreData.fingerprint_hash,
    metadata: stripBundleArtifactMetadata(rawMetadata),
    manifestStorageUri: firestoreData.manifest_storage_uri ?? null,
    manifestFileHash: firestoreData.manifest_file_hash ?? null,
    assetBaseStorageUri: firestoreData.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId:
      primaryPatch?.baseBundleId ?? firestoreData.patch_base_bundle_id ?? null,
    patchBaseFileHash:
      primaryPatch?.baseFileHash ?? firestoreData.patch_base_file_hash ?? null,
    patchFileHash:
      primaryPatch?.patchFileHash ?? firestoreData.patch_file_hash ?? null,
    patchStorageUri:
      primaryPatch?.patchStorageUri ?? firestoreData.patch_storage_uri ?? null,
    rolloutCohortCount:
      firestoreData.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: firestoreData.target_cohorts ?? null,
  };
};

export const firebaseDatabase = createDatabasePlugin<FirebaseDatabaseConfig>({
  name: "firebaseDatabase",
  factory: (config) => {
    let app: admin.app.App;
    try {
      app = admin.app();
    } catch {
      app = admin.initializeApp(config);
    }

    const db = getFirestore(app, "tile-push");
    const bundlesCollection = db.collection("bundles");
    const targetAppVersionsCollection = db.collection("target_app_versions");

    // CLI/script fallback. Runtime HTTP requests override this via ALS.
    const configAppId = config.appId;

    return {
      getUpdateInfo: createDatabasePluginGetUpdateInfo({
        async listTargetAppVersions({ platform, channel }) {
          // TENANT GUARD: every query scopes to the current tenant.
          const appId = currentAppId(configAppId);
          const querySnapshot = await targetAppVersionsCollection
            .where("app_id", "==", appId)
            .where("platform", "==", platform)
            .where("channel", "==", channel)
            .select("target_app_version")
            .get();

          return Array.from(
            new Set(
              querySnapshot.docs
                .map(
                  (doc) => doc.data().target_app_version as string | undefined,
                )
                .filter((version): version is string => Boolean(version)),
            ),
          );
        },

        async getBundlesByTargetAppVersions(
          { platform, channel, minBundleId },
          targetAppVersions,
        ) {
          const appId = currentAppId(configAppId);
          const results = await Promise.all(
            chunkValues(targetAppVersions, 10).map((versions) =>
              bundlesCollection
                .where("app_id", "==", appId)
                .where("platform", "==", platform)
                .where("channel", "==", channel)
                .where("enabled", "==", true)
                .where("id", ">=", minBundleId)
                .where("target_app_version", "in", versions)
                .get(),
            ),
          );

          return results.flatMap((snapshot) =>
            snapshot.docs.map((doc) =>
              convertToBundle(
                doc.data() as SnakeCaseBundle & { app_id?: string },
                appId,
              ),
            ),
          );
        },

        async getBundlesByFingerprint({
          platform,
          channel,
          minBundleId,
          fingerprintHash,
        }) {
          const appId = currentAppId(configAppId);
          const querySnapshot = await bundlesCollection
            .where("app_id", "==", appId)
            .where("platform", "==", platform)
            .where("channel", "==", channel)
            .where("enabled", "==", true)
            .where("id", ">=", minBundleId)
            .where("fingerprint_hash", "==", fingerprintHash)
            .get();

          return querySnapshot.docs.map((doc) =>
            convertToBundle(
              doc.data() as SnakeCaseBundle & { app_id?: string },
              appId,
            ),
          );
        },
      }),

      async getBundleById(bundleId) {
        const appId = currentAppId(configAppId);
        const bundleRef = bundlesCollection.doc(bundleId);
        const bundleSnap = await bundleRef.get();

        if (!bundleSnap.exists) {
          return null;
        }

        const firestoreData = bundleSnap.data() as SnakeCaseBundle & {
          app_id?: string;
        };
        // convertToBundle enforces app_id matches `appId` — returns null
        // if there's a mismatch (we don't want to leak existence).
        try {
          return convertToBundle(firestoreData, appId);
        } catch {
          return null;
        }
      },

      async getBundles(options) {
        const appId = currentAppId(configAppId);
        const { where, limit, orderBy } = options;
        const offset =
          (("offset" in options ? options.offset : undefined) as
            | number
            | undefined) ?? 0;

        // Lift user-provided where into a tenant-scoped where.
        const tenantWhere: TenantQueryWhere = { ...(where ?? {}), appId };

        let query = applyFirestoreQueryableFilters(
          bundlesCollection,
          tenantWhere,
        );

        query = query.orderBy(
          "id",
          orderBy?.direction === "asc" ? "asc" : "desc",
        );

        if (requiresInMemoryFiltering(where)) {
          const querySnapshot = await query.get();
          const filteredBundles = sortBundles(
            querySnapshot.docs
              .map((doc) =>
                convertToBundle(
                  doc.data() as SnakeCaseBundle & { app_id?: string },
                  appId,
                ),
              )
              .filter((bundle) =>
                bundleMatchesQueryWhere(bundle, tenantWhere),
              ),
            orderBy,
          );
          const total = filteredBundles.length;
          const data = filteredBundles.slice(offset, offset + limit);

          return {
            data,
            pagination: calculatePagination(total, {
              limit,
              offset,
            }),
          };
        }

        const totalSnapshot = await query.get();
        const total = totalSnapshot.size;

        if (offset > 0) {
          query = query.offset(offset);
        }
        if (limit) {
          query = query.limit(limit);
        }

        const querySnapshot = await query.get();

        const data = sortBundles(
          querySnapshot.docs.map((doc) =>
            convertToBundle(
              doc.data() as SnakeCaseBundle & { app_id?: string },
              appId,
            ),
          ),
          orderBy,
        );

        return {
          data,
          pagination: calculatePagination(total, {
            limit,
            offset,
          }),
        };
      },

      async getChannels() {
        const appId = currentAppId(configAppId);
        const channelsCollection = db.collection("channels");
        const querySnapshot = await channelsCollection
          .where("app_id", "==", appId)
          .get();

        if (querySnapshot.empty) {
          return [];
        }

        const channels = new Set<string>();
        for (const doc of querySnapshot.docs) {
          const data = doc.data();
          if (data.name) {
            channels.add(data.name as string);
          }
        }

        return Array.from(channels);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        // TENANT GUARD: pin the current tenant for the entire transaction.
        // All reads and writes are scoped to this appId.
        const appId = currentAppId(configAppId);

        let isTargetAppVersionChanged = false;

        await db.runTransaction(async (transaction) => {
          // Read only THIS tenant's data. Composite indexes are
          // (app_id, ...) so each tenant scans only their own slice.
          const bundlesSnapshot = await transaction.get(
            bundlesCollection.where("app_id", "==", appId),
          );
          const targetVersionsSnapshot = await transaction.get(
            db.collection("target_app_versions").where("app_id", "==", appId),
          );
          const channelsSnapshot = await transaction.get(
            db.collection("channels").where("app_id", "==", appId),
          );

          const bundlesMap: { [id: string]: any } = {};
          for (const doc of bundlesSnapshot.docs) {
            bundlesMap[doc.id] = doc.data();
          }

          // Process all operations (in-memory state for orphan calc).
          for (const { operation, data } of changedSets) {
            if (data.targetAppVersion) {
              isTargetAppVersionChanged = true;
            }

            if (operation === "insert" || operation === "update") {
              bundlesMap[data.id] = {
                id: data.id,
                app_id: appId,
                channel: data.channel,
                enabled: data.enabled,
                should_force_update: data.shouldForceUpdate,
                file_hash: data.fileHash,
                git_commit_hash: data.gitCommitHash || null,
                message: data.message || null,
                platform: data.platform,
                target_app_version: data.targetAppVersion,
                storage_uri: data.storageUri,
                fingerprint_hash: data.fingerprintHash,
                metadata: stripBundleArtifactMetadata(data.metadata) ?? {},
                manifest_storage_uri: getManifestStorageUri(data),
                manifest_file_hash: getManifestFileHash(data),
                asset_base_storage_uri: getAssetBaseStorageUri(data),
                patches: data.patches ?? null,
                patch_base_bundle_id: getPatchBaseBundleId(data),
                patch_base_file_hash: getPatchBaseFileHash(data),
                patch_file_hash: getPatchFileHash(data),
                patch_storage_uri: getPatchStorageUri(data),
                rollout_cohort_count:
                  data.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
                target_cohorts: data.targetCohorts ?? null,
              } as TenantSnakeCaseBundle;

              // Add channel to channels collection (tenant-scoped doc id).
              const channelDocId = `${appId}_${data.channel}`;
              const channelRef = db.collection("channels").doc(channelDocId);
              transaction.set(
                channelRef,
                {
                  app_id: appId,
                  name: data.channel,
                },
                { merge: true },
              );
            } else if (operation === "delete") {
              if (!bundlesMap[data.id]) {
                throw new Error(
                  `Bundle ${data.id} not found in tenant ${appId} — refusing to delete.`,
                );
              }
              delete bundlesMap[data.id];
              isTargetAppVersionChanged = true;
            }
          }

          // Calculate required target app versions and channels from
          // remaining (tenant-scoped) bundles.
          const requiredTargetVersionKeys = new Set<string>();
          const requiredChannels = new Set<string>();
          for (const bundle of Object.values(bundlesMap)) {
            if (bundle.target_app_version) {
              const key = `${appId}_${bundle.platform}_${bundle.channel}_${bundle.target_app_version}`;
              requiredTargetVersionKeys.add(key);
            }
            requiredChannels.add(`${appId}_${bundle.channel}`);
          }

          // Execute Firestore writes.
          for (const { operation, data } of changedSets) {
            const bundleRef = bundlesCollection.doc(data.id);

            if (operation === "insert" || operation === "update") {
              transaction.set(
                bundleRef,
                {
                  id: data.id,
                  app_id: appId,
                  channel: data.channel,
                  enabled: data.enabled,
                  should_force_update: data.shouldForceUpdate,
                  file_hash: data.fileHash,
                  git_commit_hash: data.gitCommitHash || null,
                  message: data.message || null,
                  platform: data.platform,
                  target_app_version: data.targetAppVersion || null,
                  storage_uri: data.storageUri,
                  fingerprint_hash: data.fingerprintHash,
                  metadata: stripBundleArtifactMetadata(data.metadata) ?? {},
                  manifest_storage_uri: getManifestStorageUri(data),
                  manifest_file_hash: getManifestFileHash(data),
                  asset_base_storage_uri: getAssetBaseStorageUri(data),
                  patches: data.patches ?? null,
                  patch_base_bundle_id: getPatchBaseBundleId(data),
                  patch_base_file_hash: getPatchBaseFileHash(data),
                  patch_file_hash: getPatchFileHash(data),
                  patch_storage_uri: getPatchStorageUri(data),
                  rollout_cohort_count:
                    data.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
                  target_cohorts: data.targetCohorts ?? null,
                } as TenantSnakeCaseBundle,
                { merge: true },
              );

              if (data.targetAppVersion) {
                // Tenant-scoped doc id prevents cross-tenant collision.
                const versionDocId = `${appId}_${data.platform}_${data.channel}_${data.targetAppVersion}`;
                const targetAppVersionsRef = db
                  .collection("target_app_versions")
                  .doc(versionDocId);
                transaction.set(
                  targetAppVersionsRef,
                  {
                    app_id: appId,
                    channel: data.channel,
                    platform: data.platform,
                    target_app_version: data.targetAppVersion,
                  },
                  { merge: true },
                );
              }
            } else if (operation === "delete") {
              // Defense-in-depth: verify the doc actually belongs to this
              // tenant before deleting. The pre-read filter above already
              // ensured this, but re-check guards against a concurrent
              // cross-tenant write between read and delete.
              const existingDoc = await transaction.get(bundleRef);
              if (existingDoc.exists) {
                const existingAppId = (
                  existingDoc.data() as { app_id?: string } | undefined
                )?.app_id;
                if (existingAppId !== appId) {
                  throw new Error(
                    `Refusing to delete ${data.id}: belongs to ${existingAppId}, not ${appId}.`,
                  );
                }
              }
              transaction.delete(bundleRef);
            }
          }

          // Clean up orphaned target_app_versions for THIS tenant only.
          if (isTargetAppVersionChanged) {
            for (const targetDoc of targetVersionsSnapshot.docs) {
              if (!requiredTargetVersionKeys.has(targetDoc.id)) {
                transaction.delete(targetDoc.ref);
              }
            }
          }

          // Clean up orphaned channels for THIS tenant only.
          for (const channelDoc of channelsSnapshot.docs) {
            if (!requiredChannels.has(channelDoc.id)) {
              transaction.delete(channelDoc.ref);
            }
          }
        });
      },
    };
  },
});
