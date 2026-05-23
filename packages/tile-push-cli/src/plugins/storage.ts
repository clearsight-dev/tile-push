import { createReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { pipeline } from "node:stream/promises";

import { createNodeStoragePlugin } from "@hot-updater/plugin-core";

import { TilePushClient } from "../auth/apiClient";

/**
 * Tile Push storage plugin.
 *
 * Implements the hot-updater NodeStoragePlugin interface as a thin HTTP
 * client against our Cloud Functions:
 *
 *   upload(key, filePath)
 *     1. POST /upload-url → get a signed GCS PUT URL
 *     2. Stream the file to that URL directly (bytes never touch our Cloud
 *        Function, only metadata does)
 *     3. Return storageUri so the deploy can write it into the bundle row
 *
 *   exists(storageUri)        — HEAD via signed read URL
 *   delete(storageUri)        — DELETE proxied through server
 *   downloadFile(uri, path)   — stream a signed read URL to disk
 *
 * supportedProtocol is "gs" because our server returns gs:// URIs (the same
 * scheme the firebase plugin's runtime side already understands when
 * generating CDN URLs during update-check).
 */

export interface TilePushStorageConfig {
  /**
   * Tenant id. Falls back to the credentials store / env vars if omitted.
   * Strongly recommended to pass explicitly so deploys don't accidentally
   * write to the wrong tenant when multiple are configured locally.
   */
  appId?: string;
  /** API base URL override. Defaults to the credentials store / env value. */
  apiUrl?: string;
}

interface UploadUrlResponse {
  uploadUrl: string;
  storageUri: string;
  requiredHeaders: Record<string, string>;
}

const detectContentType = (filePath: string): string => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz"))
    return "application/gzip";
  if (lower.endsWith(".tar.br")) return "application/x-brotli";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
};

/**
 * For PUT to GCS via signed URL, GCS expects the request body to be the raw
 * file bytes with Content-Length set. We use a buffered Buffer (rather than
 * a stream) because:
 *   1. node fetch streaming requires `duplex: "half"` which is gated behind
 *      experimental flags in some Node versions
 *   2. Bundle files are typically <50MB — easily fits in memory
 *   3. Content-Length is required by GCS signed URLs and easier from a Buffer
 */
const putToSignedUrl = async (
  uploadUrl: string,
  filePath: string,
  headers: Record<string, string>,
): Promise<void> => {
  const { readFile } = await import("node:fs/promises");
  const data = await readFile(filePath);
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Length": String(data.byteLength),
    },
    body: data,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Upload to GCS failed (HTTP ${response.status}): ${text.slice(0, 300)}`,
    );
  }
};

export const tilePushStorage = createNodeStoragePlugin<TilePushStorageConfig>({
  name: "tilePushStorage",
  supportedProtocol: "gs",
  factory: (_config) => {
    // We construct the client lazily on first use (rather than at config
    // load time) so loading the config file in non-CLI contexts (e.g. type
    // checks) doesn't require credentials to be present.
    let cachedClient: Promise<TilePushClient> | null = null;
    const getClient = () =>
      (cachedClient ??= TilePushClient.create());

    return {
      async upload(key, filePath) {
        const client = await getClient();
        // hot-updater's upload contract: the caller passes `key` as a
        // directory-like path (e.g. bundleId, or "assets/{hash}") and the
        // plugin composes `<key>/<filename>` from the filePath's basename.
        // Mirrors firebaseStorage's resolveStorageKeyBuilder().
        const filename = basename(filePath);
        const composedKey = key ? `${key}/${filename}` : filename;
        const { uploadUrl, storageUri, requiredHeaders } =
          await client.post<UploadUrlResponse>("/upload-url", {
            json: {
              key: composedKey,
              contentType: detectContentType(filePath),
            },
          });
        await putToSignedUrl(uploadUrl, filePath, requiredHeaders);
        return { storageUri };
      },

      async exists(storageUri) {
        const client = await getClient();
        try {
          const res = await client.get<{ exists: boolean }>(
            `/storage/exists?uri=${encodeURIComponent(storageUri)}`,
          );
          return res.exists;
        } catch (err) {
          // exists() should be a non-throwing probe — return false if the
          // server says 404 or any other error. Loud failures here would
          // break deploy retries.
          return false;
        }
      },

      async delete(storageUri) {
        const client = await getClient();
        await client.delete(
          `/storage?uri=${encodeURIComponent(storageUri)}`,
        );
      },

      async downloadFile(storageUri, filePath) {
        const client = await getClient();
        const { downloadUrl } = await client.get<{ downloadUrl: string }>(
          `/storage/download-url?uri=${encodeURIComponent(storageUri)}`,
        );
        const response = await fetch(downloadUrl);
        if (!response.ok || !response.body) {
          throw new Error(
            `Failed to download ${storageUri} (HTTP ${response.status})`,
          );
        }
        await mkdir(dirname(filePath), { recursive: true });
        const writeStream = createWriteStream(filePath);
        // node 18+ stream interop: Response.body is a WebReadableStream
        const { Readable } = await import("node:stream");
        await pipeline(
          Readable.fromWeb(response.body as never),
          writeStream,
        );
      },
    };
  },
});

// Re-export for type-only consumers
export type TilePushStoragePlugin = ReturnType<
  ReturnType<typeof tilePushStorage>
>;
