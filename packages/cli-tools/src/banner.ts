import boxen from "boxen";
import picocolors from "picocolors";

export const link = (url: string) => {
  return picocolors.green(picocolors.underline(url));
};

export const banner = (version?: string) =>
  boxen(
    [
      `${picocolors.bold("Hot Updater - React Native OTA Solution")} ${version ? `v${version}` : ""}`,
      "",
      `Github: ${link("https://github.com/gronxb/hot-updater")}`,
      "Give a ⭐️ if you like it!",
    ].join("\n"),
    {
      padding: 1,
      borderStyle: "round",
      borderColor: "green",
      textAlignment: "center",
    },
  );

export const printBanner = (version?: string) => {
  // Wrapper CLIs (e.g. tile-push) can suppress the banner by setting
  // HOT_UPDATER_SKIP_BANNER=1 in the environment. They typically print
  // their own branded banner before invoking commands.
  if (process.env.HOT_UPDATER_SKIP_BANNER) return;
  console.log(banner(version));
};
