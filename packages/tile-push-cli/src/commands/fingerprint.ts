import { Command } from "commander";
import {
  handleCreateFingerprint,
  handleFingerprint,
} from "hot-updater/internal/commands";

import { withOutputFilter } from "../utils/outputFilter";

/**
 * tile-push fingerprint           — compute / verify current fingerprint
 * tile-push fingerprint create    — write a new fingerprint snapshot
 *
 * Fingerprints are pure local computation (no server interaction), so
 * these wraps exist purely for branding consistency.
 */
export const registerFingerprint = (program: Command): void => {
  const fpCmd = program.command("fingerprint").description("Generate fingerprint");

  fpCmd.action(async () => {
    process.env.HOT_UPDATER_CONFIG_NAME = "tile-push";
    process.env.HOT_UPDATER_SKIP_BANNER = "1";
    await withOutputFilter(() => handleFingerprint());
  });

  fpCmd
    .command("create")
    .description("Create fingerprint")
    .action(async () => {
      process.env.HOT_UPDATER_CONFIG_NAME = "tile-push";
      process.env.HOT_UPDATER_SKIP_BANNER = "1";
      await withOutputFilter(() => handleCreateFingerprint());
    });
};
