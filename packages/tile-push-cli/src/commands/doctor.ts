import { existsSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";
import picocolors from "picocolors";

import { TilePushClient } from "../auth/apiClient";
import { credentialsDiagnostic, loadCredentials } from "../auth/tokenStore";
import { tilePushError } from "../branding";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const fmt = (c: Check): string => {
  const mark =
    c.status === "ok"
      ? picocolors.green("✔")
      : c.status === "warn"
        ? picocolors.yellow("!")
        : picocolors.red("✖");
  return `${mark} ${c.name} — ${c.detail}`;
};

/**
 * tile-push doctor
 *
 * Runs through the common setup checks and reports which ones pass/fail.
 * Customer-facing — message wording assumes no prior context.
 */
export const registerDoctor = (program: Command): void => {
  program
    .command("doctor")
    .description("Check the health of your Tile Push setup")
    .option("--json", "output machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const checks: Check[] = [];
      const cwd = process.cwd();

      // ---- Config file ----
      const configPath = join(cwd, "tile-push.config.ts");
      checks.push(
        existsSync(configPath)
          ? {
              name: "Config",
              status: "ok",
              detail: `tile-push.config.ts found at ${cwd}`,
            }
          : {
              name: "Config",
              status: "fail",
              detail:
                "tile-push.config.ts missing in cwd. Run `tile-push init`.",
            },
      );

      // ---- Credentials ----
      const diag = await credentialsDiagnostic();
      if (diag.source === "env") {
        checks.push({
          name: "Credentials",
          status: "ok",
          detail: `Loaded from ${diag.pathOrEnv}`,
        });
      } else if (diag.source === "file") {
        checks.push({
          name: "Credentials",
          status: diag.modeOk ? "ok" : "warn",
          detail: diag.modeOk
            ? `Loaded from ${diag.pathOrEnv} (mode 0600)`
            : `Loaded from ${diag.pathOrEnv} but permissions are not 0600 — anyone with shell access can read your deploy token`,
        });
      } else {
        checks.push({
          name: "Credentials",
          status: "fail",
          detail: `No credentials. Run \`tile-push init\` or set TILE_PUSH_APP_ID + TILE_PUSH_TOKEN.`,
        });
      }

      // ---- Server reachability + token validity ----
      const creds = await loadCredentials();
      if (creds) {
        try {
          const client = await TilePushClient.create();
          const me = await client.get<{ tenantName: string; tokenLabel: string }>(
            "/me",
          );
          checks.push({
            name: "Server",
            status: "ok",
            detail: `Authenticated as "${me.tenantName}" with token "${me.tokenLabel}"`,
          });
        } catch (err) {
          checks.push({
            name: "Server",
            status: "fail",
            detail: `Could not reach Tile Push API: ${(err as Error).message}`,
          });
        }
      } else {
        checks.push({
          name: "Server",
          status: "warn",
          detail: "Skipped — no credentials to test with",
        });
      }

      // ---- Bundler detection ----
      const pkgPath = join(cwd, "package.json");
      if (existsSync(pkgPath)) {
        checks.push({
          name: "Project",
          status: "ok",
          detail: `package.json found at ${cwd}`,
        });
      } else {
        checks.push({
          name: "Project",
          status: "warn",
          detail: "No package.json in cwd — run doctor from your RN project root",
        });
      }

      if (options.json) {
        console.log(JSON.stringify(checks, null, 2));
        const ok = checks.every((c) => c.status === "ok");
        if (!ok) process.exitCode = 1;
        return;
      }

      for (const c of checks) console.log(fmt(c));
      const failed = checks.filter((c) => c.status === "fail");
      if (failed.length > 0) {
        console.log("");
        console.log(tilePushError(`${failed.length} check(s) failed.`));
        process.exitCode = 1;
      } else {
        console.log("");
        console.log(picocolors.green("All checks passed."));
      }
    });
};
