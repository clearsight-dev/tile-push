import picocolors from "picocolors";

/**
 * Tile Push CLI banner. Printed at the start of each branded command
 * (deploy, init, bundle ops). Replaces the hot-updater banner which is
 * suppressed via HOT_UPDATER_SKIP_BANNER=1 when we invoke wrapped commands.
 */

const BANNER_LINES = [
  "  ████████╗██╗██╗     ███████╗    ██████╗ ██╗   ██╗███████╗██╗  ██╗",
  "  ╚══██╔══╝██║██║     ██╔════╝    ██╔══██╗██║   ██║██╔════╝██║  ██║",
  "     ██║   ██║██║     █████╗      ██████╔╝██║   ██║███████╗███████║",
  "     ██║   ██║██║     ██╔══╝      ██╔═══╝ ██║   ██║╚════██║██╔══██║",
  "     ██║   ██║███████╗███████╗    ██║     ╚██████╔╝███████║██║  ██║",
  "     ╚═╝   ╚═╝╚══════╝╚══════╝    ╚═╝      ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

const TAGLINE = "Multi-tenant OTA updates for React Native";

export const printTilePushBanner = (version?: string): void => {
  if (process.env.TILE_PUSH_SKIP_BANNER) return;
  const lines: string[] = ["", ...BANNER_LINES.map((l) => picocolors.cyan(l))];
  const taglineLine = version
    ? `${TAGLINE}  ·  v${version}`
    : TAGLINE;
  lines.push("", `  ${picocolors.dim(taglineLine)}`, "");
  console.log(lines.join("\n"));
};

/**
 * Branded success message — used at the end of deploy / bundle commands.
 */
export const tilePushSuccess = (msg: string): string =>
  `${picocolors.green("✔")} ${msg}`;

/**
 * Branded error message — for top-level catches before process exit.
 */
export const tilePushError = (msg: string): string =>
  `${picocolors.red("✖")} ${picocolors.red(msg)}`;
