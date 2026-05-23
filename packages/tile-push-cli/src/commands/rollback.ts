import { Command, Option } from "commander";
import { handleRollback } from "hot-updater/internal/commands";

import { withOutputFilter } from "../utils/outputFilter";

/**
 * tile-push rollback <channel>
 *
 * Disables the most recent enabled bundle on a channel. The device picks
 * up the disabled flag on its next check-update and rolls back to the
 * previous enabled bundle (or INIT_ROLLBACK if none).
 */
export const registerRollback = (program: Command): void => {
  program
    .command("rollback")
    .description("Disable the most recent enabled bundle on a channel")
    .argument("<channel>", "channel to roll back")
    .addOption(
      new Option("--platform <platform>", "ios | android").choices([
        "ios",
        "android",
      ]),
    )
    .option("-y, --yes", "skip confirmation prompt")
    .option(
      "--target <bundle-id>",
      "scope rollback to exactly this bundle id (use to retry a failed rollback)",
    )
    .action(async (channel: string, options) => {
      process.env.HOT_UPDATER_CONFIG_NAME = "tile-push";
      process.env.HOT_UPDATER_SKIP_BANNER = "1";
      await withOutputFilter(() => handleRollback(channel, options));
    });
};
