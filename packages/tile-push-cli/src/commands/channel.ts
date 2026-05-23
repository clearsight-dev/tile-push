import { Command } from "commander";
import { handleChannel, handleSetChannel } from "hot-updater/internal/commands";

import { withOutputFilter } from "../utils/outputFilter";

/**
 * tile-push channel
 * tile-push channel set <channel>
 *
 * Reads/writes native files (Android BuildConfig, iOS Info.plist) — no
 * server interaction, just local file ops.
 */
export const registerChannel = (program: Command): void => {
  const channelCmd = program.command("channel").description("Manage channels");

  channelCmd.action(async () => {
    process.env.HOT_UPDATER_CONFIG_NAME = "tile-push";
    process.env.HOT_UPDATER_SKIP_BANNER = "1";
    await withOutputFilter(() => handleChannel());
  });

  channelCmd
    .command("set")
    .description(
      "Set the channel for Android (BuildConfig) and iOS (Info.plist)",
    )
    .argument("<channel>", "channel to set")
    .action(async (channel: string) => {
      process.env.HOT_UPDATER_CONFIG_NAME = "tile-push";
      process.env.HOT_UPDATER_SKIP_BANNER = "1";
      await withOutputFilter(() => handleSetChannel(channel));
    });
};
