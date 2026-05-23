/**
 * Output filter that rewrites "hot-updater" / "Hot Updater" strings in
 * stdout/stderr to their Tile Push equivalents, so wrapped command output
 * never leaks the underlying tool's name.
 *
 * Implementation: we hijack process.stdout.write and process.stderr.write
 * for the duration of the wrapped call, run the regex on each chunk before
 * forwarding to the original writer. ANSI color codes pass through untouched
 * because the regex only matches alphabetic sequences.
 *
 * `withOutputFilter(fn)` is fire-and-forget — even if fn throws, the
 * originals are restored in a finally.
 */

type WriteFn = (
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
  callback?: (err?: Error | null) => void,
) => boolean;

// Order matters: capitalised first, so "Hot Updater" → "Tile Push" before
// the lowercase rule rewrites "hot-updater" → "tile-push".
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/Hot Updater/g, "Tile Push"],
  [/HotUpdater/g, "TilePush"],
  [/hot-updater/g, "tile-push"],
];

const rewrite = (s: string): string => {
  let out = s;
  for (const [pat, rep] of REPLACEMENTS) {
    out = out.replace(pat, rep);
  }
  return out;
};

const wrap = (original: WriteFn): WriteFn => {
  return function wrapped(this: NodeJS.WriteStream, chunk, encOrCb, cb) {
    const buf = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const filtered = rewrite(buf);
    // Forward through the original signature variants
    if (typeof encOrCb === "function") {
      return original.call(this, filtered, encOrCb);
    }
    return original.call(this, filtered, encOrCb, cb);
  } as WriteFn;
};

export const withOutputFilter = async <T>(
  fn: () => Promise<T> | T,
): Promise<T> => {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = wrap(origOut) as typeof process.stdout.write;
  process.stderr.write = wrap(origErr) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = origOut as typeof process.stdout.write;
    process.stderr.write = origErr as typeof process.stderr.write;
  }
};
