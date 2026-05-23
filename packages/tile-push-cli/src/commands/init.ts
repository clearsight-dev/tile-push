import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { Command } from "commander";
import picocolors from "picocolors";

import { saveCredentials } from "../auth/tokenStore";
import { printTilePushBanner, tilePushError, tilePushSuccess } from "../branding";

/**
 * tile-push init
 *
 * One-shot setup for a customer project. Walks the user through:
 *   1. appId + deploy token
 *   2. detect or pick the bundler (Metro / Expo)
 *   3. write tile-push.config.ts (uses HOT_UPDATER_CONFIG_NAME=tile-push)
 *   4. write ~/.tile-push/credentials.json (chmod 600)
 *   5. add TILE_PUSH_APP_ID to .env (for CI runs / explicit reference)
 *
 * Idempotent: if any file exists, asks before overwriting.
 */

interface InitOptions {
  appId?: string;
  token?: string;
  bundler?: "metro" | "expo";
  apiUrl?: string;
  yes?: boolean;
}

const prompt = (question: string, defaultValue?: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const promptText = defaultValue
    ? `${question} ${picocolors.dim(`(${defaultValue})`)} `
    : `${question} `;
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
};

const promptYesNo = async (
  question: string,
  defaultYes = true,
): Promise<boolean> => {
  const hint = defaultYes ? "Y/n" : "y/N";
  const ans = await prompt(`${question} ${picocolors.dim(`[${hint}]`)}`);
  if (!ans) return defaultYes;
  return /^y(es)?$/i.test(ans);
};

const detectBundler = (cwd: string): "metro" | "expo" | null => {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    if (all.expo) return "expo";
    if (all["react-native"]) return "metro";
  } catch {
    /* fall through */
  }
  return null;
};

const renderConfig = (bundler: "metro" | "expo"): string => {
  const buildImport =
    bundler === "expo"
      ? `import { expo } from "@hot-updater/expo";`
      : `import { metro } from "@hot-updater/metro";`;
  const buildCall = bundler === "expo" ? "expo()" : "metro()";
  return `import { defineConfig } from "hot-updater";
${buildImport}
import { tilePushDatabase, tilePushStorage } from "@tile-push/cli";

const appId = process.env.TILE_PUSH_APP_ID;
if (!appId) {
  throw new Error(
    "TILE_PUSH_APP_ID is not set. Run \`tile-push init\` or export it manually.",
  );
}

export default defineConfig({
  build: ${buildCall},
  storage: tilePushStorage({ appId }),
  database: tilePushDatabase({ appId }),
});
`;
};

const upsertEnv = async (path: string, key: string, value: string): Promise<void> => {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const lines = existing.split("\n");
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) {
    if (existing && !existing.endsWith("\n")) lines.push("");
    lines.push(`${key}=${value}`);
  }
  await writeFile(path, lines.join("\n"));
};

export const registerInit = (program: Command): void => {
  program
    .command("init")
    .description("Configure a project for Tile Push deploys")
    .option("--app-id <appId>", "tenant app id (tk_...)")
    .option("--token <token>", "deploy token")
    .option(
      "--bundler <bundler>",
      "bundler to use (metro|expo); auto-detected if omitted",
    )
    .option("--api-url <url>", "Tile Push API URL override")
    .option("-y, --yes", "accept overwrites without prompting")
    .action(async (options: InitOptions) => {
      printTilePushBanner();

      const cwd = process.cwd();
      const configPath = join(cwd, "tile-push.config.ts");
      const envPath = join(cwd, ".env");

      // ---- 1. Gather inputs ----
      const appId =
        options.appId ?? (await prompt("App id (e.g. tk_acme):"));
      if (!appId) {
        console.error(tilePushError("App id is required."));
        process.exitCode = 1;
        return;
      }

      const token =
        options.token ??
        (await prompt(
          "Deploy token (paste from the Tile Push console):",
        ));
      if (!token) {
        console.error(tilePushError("Deploy token is required."));
        process.exitCode = 1;
        return;
      }

      const detected = detectBundler(cwd);
      const bundler =
        options.bundler ??
        ((detected ??
          ((await prompt(
            "Bundler (metro|expo):",
            "metro",
          )) as "metro" | "expo")) as "metro" | "expo");

      // ---- 2. Write config (with overwrite confirmation) ----
      if (existsSync(configPath) && !options.yes) {
        const overwrite = await promptYesNo(
          `${configPath} already exists. Overwrite?`,
          false,
        );
        if (!overwrite) {
          console.log("Skipped config write.");
        } else {
          await writeFile(configPath, renderConfig(bundler));
          console.log(tilePushSuccess(`Wrote ${configPath}`));
        }
      } else {
        await writeFile(configPath, renderConfig(bundler));
        console.log(tilePushSuccess(`Wrote ${configPath}`));
      }

      // ---- 3. Update .env ----
      await upsertEnv(envPath, "TILE_PUSH_APP_ID", appId);
      console.log(tilePushSuccess(`Added TILE_PUSH_APP_ID to ${envPath}`));

      // ---- 4. Save credentials ----
      await saveCredentials({
        appId,
        token,
        apiUrl: options.apiUrl,
      });
      console.log(tilePushSuccess("Saved credentials to ~/.tile-push/credentials.json"));

      console.log("");
      console.log(`Next steps:`);
      console.log(`  ${picocolors.cyan("tile-push deploy")}  — ship a bundle`);
      console.log(`  ${picocolors.cyan("tile-push whoami")}  — verify your connection`);
      console.log(`  ${picocolors.cyan("tile-push doctor")}  — diagnose setup issues`);
    });
};
