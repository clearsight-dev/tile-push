import fs from "fs/promises";
import path from "path";

import {
  createStorageKeyBuilder,
  createUniversalStoragePlugin,
  getContentType,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import admin from "firebase-admin";

import { currentAppId } from "./tenantContext";

export interface FirebaseStorageConfig extends admin.AppOptions {
  storageBucket: string;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
  /**
   * If set, getDownloadUrl returns `${cdnUrl}/${key}` instead of a signed URL.
   * Requires the bucket (or the CDN) to serve the object publicly. Skipping
   * signBlob removes a ~600ms IAM round-trip per check-update and removes the
   * concurrency bottleneck that serializes signing calls.
   */
  cdnUrl?: string;
  /**
   * Tenant scope. Used by upload() to prefix storage keys with t/{appId}/.
   * Resolved as: ALS context > this field > throw.
   *
   * For CLI use (single tenant per config), set this field in
   * hot-updater.config.ts. For multi-tenant runtime, leave undefined — the
   * tenantALS context (set by the Cloud Function middleware) supplies appId.
   */
  appId?: string;
}

export const firebaseStorage =
  createUniversalStoragePlugin<FirebaseStorageConfig>({
    name: "firebaseStorage",
    supportedProtocol: "gs",
    factory: (config) => {
      let app: admin.app.App;
      try {
        app = admin.app();
      } catch {
        app = admin.initializeApp(config);
      }
      const bucket = app.storage().bucket(config.storageBucket);

      // Compose tenant prefix into the storage key builder. The tenant
      // segment (t/{appId}) goes BEFORE any user-provided basePath, so
      // every bundle's storage path is unambiguously tenant-scoped:
      //   t/{appId}/{basePath?}/{bundleId}/bundle.zip
      const resolveStorageKeyBuilder = () => {
        const appId = currentAppId(config.appId);
        const tenantSegment = `t/${appId}`;
        const combined = config.basePath
          ? `${tenantSegment}/${config.basePath}`
          : tenantSegment;
        return createStorageKeyBuilder(combined);
      };

      return {
        node: {
          async delete(storageUri) {
            const { bucket: bucketName, key } = parseStorageUri(
              storageUri,
              "gs",
            );
            if (bucketName !== config.storageBucket) {
              throw new Error(
                `Bucket name mismatch: expected "${config.storageBucket}", but found "${bucketName}".`,
              );
            }

            try {
              const [files] = await bucket.getFiles({ prefix: key });
              await Promise.all(files.map((file) => file.delete()));
            } catch (e) {
              console.error("Error listing or deleting files:", e);
              throw new Error("Bundle Not Found");
            }
          },

          async upload(key, filePath) {
            try {
              const fileContent = await fs.readFile(filePath);
              const contentType = getContentType(filePath);
              const filename = path.basename(filePath);
              // Tenant-scoped key. Resolved per-upload because ALS context
              // could differ between calls (multi-tenant CLI use case).
              const storageKey = resolveStorageKeyBuilder()(key, filename);

              const file = bucket.file(storageKey);
              await file.save(fileContent, {
                metadata: {
                  contentType: contentType,
                  cacheControl: "public, max-age=31536000, immutable",
                },
              });

              return {
                storageUri: `gs://${config.storageBucket}/${storageKey}`,
              };
            } catch (error) {
              console.error("Error uploading bundle:", error);
              if (error instanceof Error) {
                throw new Error(`Failed to upload bundle: ${error.message}`);
              }
              throw error;
            }
          },
          async exists(storageUri: string) {
            const { bucket: bucketName, key } = parseStorageUri(
              storageUri,
              "gs",
            );
            if (bucketName !== config.storageBucket) {
              throw new Error(
                `Bucket name mismatch: expected "${config.storageBucket}", but found "${bucketName}".`,
              );
            }

            const [exists] = await bucket.file(key).exists();
            return exists;
          },
          async downloadFile(storageUri: string, filePath: string) {
            const { bucket: bucketName, key } = parseStorageUri(
              storageUri,
              "gs",
            );
            if (bucketName !== config.storageBucket) {
              throw new Error(
                `Bucket name mismatch: expected "${config.storageBucket}", but found "${bucketName}".`,
              );
            }

            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await bucket.file(key).download({ destination: filePath });
          },
        },
        runtime: {
          async readText(storageUri: string) {
            const { bucket: bucketName, key } = parseStorageUri(
              storageUri,
              "gs",
            );
            if (bucketName !== config.storageBucket) {
              throw new Error(
                `Bucket name mismatch: expected "${config.storageBucket}", but found "${bucketName}".`,
              );
            }

            try {
              const [contents] = await bucket.file(key).download();
              return contents.toString("utf8");
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === 404
              ) {
                return null;
              }

              throw error;
            }
          },
          async getDownloadUrl(storageUri: string) {
            // Simple validation: supported protocol must match
            const u = new URL(storageUri);
            if (u.protocol.replace(":", "") !== "gs") {
              throw new Error("Invalid Firebase storage URI protocol");
            }
            const key = u.pathname.slice(1);
            if (!key) {
              throw new Error("Invalid Firebase storage URI: missing key");
            }
            if (config.cdnUrl) {
              const base = config.cdnUrl.replace(/\/+$/, "");
              return { fileUrl: `${base}/${key}` };
            }
            const file = bucket.file(key);
            const [signedUrl] = await file.getSignedUrl({
              action: "read",
              expires: Date.now() + 60 * 60 * 1000,
            });
            if (!signedUrl) {
              throw new Error("Failed to generate download URL");
            }
            return { fileUrl: signedUrl };
          },
        },
      };
    },
  });
