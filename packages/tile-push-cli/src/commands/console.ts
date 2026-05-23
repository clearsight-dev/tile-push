import { Command } from "commander";
import open from "open";

import { TilePushClient } from "../auth/apiClient";
import { tilePushError } from "../branding";

const DEFAULT_CONSOLE_URL = "https://console.tile-push.app";

/**
 * tile-push console
 *
 * Opens the web console for the current tenant in the default browser.
 * The URL is derived from the active appId so customers don't have to
 * remember it (or paste it from Slack).
 */
export const registerConsole = (program: Command): void => {
  program
    .command("console")
    .description("Open the Tile Push web console for the current tenant")
    .option(
      "--url <baseUrl>",
      "console base URL (defaults to https://console.tile-push.app)",
    )
    .action(async (options: { url?: string }) => {
      try {
        const client = await TilePushClient.create();
        const base = (options.url ?? DEFAULT_CONSOLE_URL).replace(/\/+$/, "");
        const target = `${base}/${encodeURIComponent(client.appId)}`;
        console.log(`Opening ${target} ...`);
        await open(target);
      } catch (err) {
        console.error(tilePushError((err as Error).message));
        process.exitCode = 1;
      }
    });
};
