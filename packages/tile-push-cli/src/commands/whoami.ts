import { Command } from "commander";
import picocolors from "picocolors";

import { TilePushApiError, TilePushClient } from "../auth/apiClient";
import { tilePushError } from "../branding";

/**
 * tile-push whoami
 *
 * Hits GET /me on the server and prints the active tenant identity. Useful
 * for confirming the right credentials are in place before deploying.
 */
export const registerWhoami = (program: Command): void => {
  program
    .command("whoami")
    .description("Show the active Tile Push tenant and token info")
    .option("--json", "output as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const client = await TilePushClient.create();
        const me = await client.get<{
          appId: string;
          tenantName: string;
          tokenLabel: string;
        }>("/me");

        if (options.json) {
          console.log(JSON.stringify(me, null, 2));
          return;
        }
        console.log(`${picocolors.bold("Tenant:")} ${me.tenantName}`);
        console.log(`${picocolors.bold("App id:")} ${me.appId}`);
        console.log(`${picocolors.bold("Token: ")} ${me.tokenLabel}`);
      } catch (err) {
        if (err instanceof TilePushApiError) {
          console.error(tilePushError(err.message));
        } else {
          console.error(tilePushError((err as Error).message));
        }
        process.exitCode = 1;
      }
    });
};
