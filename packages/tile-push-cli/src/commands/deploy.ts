import { Command, InvalidArgumentError, Option } from "commander";
import { deploy, normalizeRolloutPercentage } from "hot-updater/internal/commands";

import { printTilePushBanner } from "../branding";
import { withOutputFilter } from "../utils/outputFilter";

// Match the semver patterns hot-updater accepts (e.g. 1.0.0, 1.x.x).
// Hot-updater also re-validates internally; we early-fail for a clearer error.
const SEMVER_RANGE_PATTERN = /^[\d\sxX*~^.<>=|&-]+$/;

const DEFAULT_CHANNEL = "production";

/**
 * tile-push deploy
 *
 * Wraps hot-updater's deploy command. The wrap injects:
 *   - HOT_UPDATER_CONFIG_NAME=tile-push so the loader looks for tile-push.config.ts
 *   - HOT_UPDATER_SKIP_BANNER=1 so the hot-updater banner is suppressed
 *   - withOutputFilter() so any leaking "Hot Updater" strings become "Tile Push"
 *   - our own banner before invocation
 */
export const registerDeploy = (program: Command): void => {
  program
    .command("deploy")
    .description("Build and ship a new bundle to Tile Push")
    .addOption(
      new Option("-p, --platform <platform>", "ios | android").choices([
        "ios",
        "android",
      ]),
    )
    .addOption(
      new Option(
        "-t, --target-app-version <targetAppVersion>",
        "target app version (semver, e.g. 1.0.0, 1.x.x)",
      ).argParser((value) => {
        if (!SEMVER_RANGE_PATTERN.test(value)) {
          throw new InvalidArgumentError(
            "Invalid semver range (e.g. 1.0.0, 1.x.x).",
          );
        }
        return value;
      }),
    )
    .addOption(new Option("-d, --disabled", "ship disabled").default(false))
    .addOption(
      new Option("-f, --force-update", "require immediate update on launch").default(
        false,
      ),
    )
    .addOption(
      new Option(
        "-o, --bundle-output-path <bundleOutputPath>",
        "output dir for the bundle archive",
      ),
    )
    .addOption(
      new Option(
        "-r, --rollout <percentage>",
        "rollout percentage (0-100)",
      )
        .argParser((value) => {
          try {
            return normalizeRolloutPercentage(value);
          } catch (error) {
            throw new InvalidArgumentError((error as Error).message);
          }
        })
        .default(100),
    )
    .addOption(
      new Option(
        "-i, --interactive",
        "prompt for missing options interactively",
      ).default(true),
    )
    .addOption(
      new Option("-c, --channel <channel>", "release channel").default(
        DEFAULT_CHANNEL,
      ),
    )
    .addOption(
      new Option(
        "-m, --message <message>",
        "release notes; falls back to the latest git commit message",
      ),
    )
    .action(async (options) => {
      process.env.HOT_UPDATER_CONFIG_NAME = "tile-push";
      process.env.HOT_UPDATER_SKIP_BANNER = "1";
      printTilePushBanner();
      await withOutputFilter(() => deploy(options));
    });
};
