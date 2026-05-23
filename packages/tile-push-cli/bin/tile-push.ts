#!/usr/bin/env node
import { Command } from "commander";

import { registerBundle } from "../src/commands/bundle";
import { registerChannel } from "../src/commands/channel";
import { registerConsole } from "../src/commands/console";
import { registerDeploy } from "../src/commands/deploy";
import { registerDoctor } from "../src/commands/doctor";
import { registerFingerprint } from "../src/commands/fingerprint";
import { registerInit } from "../src/commands/init";
import { registerRollback } from "../src/commands/rollback";
import { registerWhoami } from "../src/commands/whoami";

const VERSION = "0.1.0";

const program = new Command();
program
  .name("tile-push")
  .description("Tile Push — multi-tenant OTA updates for React Native")
  .version(VERSION);

registerInit(program);
registerDeploy(program);
registerBundle(program);
registerRollback(program);
registerChannel(program);
registerFingerprint(program);
registerWhoami(program);
registerConsole(program);
registerDoctor(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
