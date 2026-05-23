import { loadCredentials, requireCredentials, type TilePushCredentials } from "./tokenStore";

/**
 * Thin fetch wrapper that injects the Bearer token, prepends the tenant
 * prefix to relative paths, parses JSON, and throws typed errors.
 *
 * Usage:
 *   const client = await TilePushClient.create();
 *   const me = await client.get<{ appId, tenantName, tokenLabel }>("/me");
 *
 * All `pathSuffix` arguments are appended to `/api/cli/t/{appId}/`, so
 * the client never has to think about tenant routing.
 */

export class TilePushApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "TilePushApiError";
  }
}

interface RequestOptions {
  /** Override Content-Type. Defaults to application/json for body-bearing methods. */
  contentType?: string;
  /** Custom headers (merged with defaults). */
  headers?: Record<string, string>;
  /** Raw body (Buffer or stream). If unset and `json` is set, json is used. */
  body?: BodyInit;
  /** JSON-encodable body. Auto-stringified. */
  json?: unknown;
  /** Don't parse the response as JSON; return raw Response. */
  raw?: boolean;
}

export class TilePushClient {
  private constructor(private readonly creds: TilePushCredentials) {}

  static async create(): Promise<TilePushClient> {
    const creds = await requireCredentials();
    return new TilePushClient(creds);
  }

  /** Like create() but returns null instead of throwing if no creds set. */
  static async createOptional(): Promise<TilePushClient | null> {
    const creds = await loadCredentials();
    return creds ? new TilePushClient(creds) : null;
  }

  get appId(): string {
    return this.creds.appId;
  }

  get apiUrl(): string {
    return this.creds.apiUrl ?? "https://api.tile-push.app";
  }

  private buildUrl(pathSuffix: string): string {
    const base = this.apiUrl.replace(/\/+$/, "");
    const suffix = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
    return `${base}/api/cli/t/${encodeURIComponent(this.creds.appId)}${suffix}`;
  }

  private async request<T>(
    method: string,
    pathSuffix: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.creds.token}`,
      ...options.headers,
    };

    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["Content-Type"] = options.contentType ?? "application/json";
    } else if (options.body !== undefined) {
      body = options.body;
      if (options.contentType) headers["Content-Type"] = options.contentType;
    }

    const url = this.buildUrl(pathSuffix);
    const response = await fetch(url, { method, headers, body });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      const message =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${response.status}`;
      throw new TilePushApiError(
        `${method} ${pathSuffix} failed: ${message}`,
        response.status,
        parsed,
      );
    }

    if (options.raw) return response as unknown as T;
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  get<T>(pathSuffix: string, options?: Omit<RequestOptions, "json" | "body">) {
    return this.request<T>("GET", pathSuffix, options);
  }

  post<T>(pathSuffix: string, options?: RequestOptions) {
    return this.request<T>("POST", pathSuffix, options);
  }

  patch<T>(pathSuffix: string, options?: RequestOptions) {
    return this.request<T>("PATCH", pathSuffix, options);
  }

  delete<T>(pathSuffix: string, options?: RequestOptions) {
    return this.request<T>("DELETE", pathSuffix, options);
  }
}
