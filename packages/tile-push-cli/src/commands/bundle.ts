import { Command, InvalidArgumentError, Option } from "commander";
import {
  handleBundleDelete,
  handleBundleList,
  handleBundleSetEnabled,
  handleBundleShow,
  handleBundleUpdate,
  handlePromote,
} from "hot-updater/internal/commands";

import { withOutputFilter } from "../utils/outputFilter";

const parseBooleanOption = (value: string): boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidArgumentError("must be true or false");
};

const parseRolloutCohortCount = (value: string): number => {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 0 || count > 1000) {
    throw new InvalidArgumentError("must be an integer between 0 and 1000");
  }
  return count;
};

const platformOption = new Option(
  "--platform <platform>",
  "ios | android",
).choices(["ios", "android"]);

const withWrapEnv = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  process.env.HOT_UPDATER_CONFIG_NAME = "tile-push";
  process.env.HOT_UPDATER_SKIP_BANNER = "1";
  return withOutputFilter(fn);
};

/**
 * tile-push bundle <subcommand>
 *
 * Wraps hot-updater's bundle management commands. All subcommands run
 * through the configured database plugin — for tile-push customers that's
 * our tilePushDatabase, which proxies every call through the server.
 */
export const registerBundle = (program: Command): void => {
  const bundleCmd = program.command("bundle").description("Manage bundles");

  bundleCmd
    .command("list")
    .description("List bundles, most recent first")
    .option("-c, --channel <channel>", "filter by channel")
    .option("--json", "output raw JSON")
    .addOption(platformOption)
    .option(
      "--limit <n>",
      "max results",
      (value) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isInteger(n) || n <= 0) {
          throw new InvalidArgumentError("must be a positive integer");
        }
        return n;
      },
      20,
    )
    .action(async (options) => {
      await withWrapEnv(() => handleBundleList(options));
    });

  bundleCmd
    .command("show")
    .description("Show one bundle by id")
    .argument("<bundle-id>", "bundle id")
    .option("--json", "output raw JSON")
    .action(async (bundleId: string, options: { json?: boolean }) => {
      await withWrapEnv(() => handleBundleShow(bundleId, options));
    });

  bundleCmd
    .command("disable")
    .description("Disable a bundle by id")
    .argument("<bundle-id>", "bundle id")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (bundleId: string, options: { yes?: boolean }) => {
      await withWrapEnv(() =>
        handleBundleSetEnabled(bundleId, false, options),
      );
    });

  bundleCmd
    .command("enable")
    .description("Re-enable a bundle by id")
    .argument("<bundle-id>", "bundle id")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (bundleId: string, options: { yes?: boolean }) => {
      await withWrapEnv(() =>
        handleBundleSetEnabled(bundleId, true, options),
      );
    });

  bundleCmd
    .command("update")
    .description("Update bundle rollout / targeting metadata")
    .argument("<bundle-id>", "bundle id")
    .option(
      "--rollout-cohort-count <count>",
      "rollout cohort count (0-1000)",
      parseRolloutCohortCount,
    )
    .option(
      "--force-update <value>",
      "force-update flag (true or false)",
      parseBooleanOption,
    )
    .option("--target-cohorts <cohorts>", "comma-separated target cohorts")
    .option("--clear-target-cohorts", "clear target cohorts")
    .option("--json", "output the updated bundle as JSON")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (...args) => {
      await withWrapEnv(() => handleBundleUpdate(...(args as Parameters<typeof handleBundleUpdate>)));
    });

  bundleCmd
    .command("delete")
    .description("Delete a bundle record by id")
    .argument("<bundle-id>", "bundle id")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (bundleId: string, options: { yes?: boolean }) => {
      await withWrapEnv(() => handleBundleDelete(bundleId, options));
    });

  bundleCmd
    .command("promote")
    .description("Move or copy a bundle to a different channel")
    .argument("<bundle-id>", "bundle id")
    .requiredOption(
      "-t, --target <channel>",
      "target channel",
    )
    .addOption(
      new Option(
        "-a, --action <action>",
        "copy creates a new bundle id; move keeps the id",
      )
        .choices(["copy", "move"])
        .default("copy"),
    )
    .option("-y, --yes", "skip confirmation prompt")
    .action(
      async (
        bundleId: string,
        options: {
          target: string;
          action: "copy" | "move";
          yes?: boolean;
        },
      ) => {
        await withWrapEnv(() => handlePromote(bundleId, options));
      },
    );
};
