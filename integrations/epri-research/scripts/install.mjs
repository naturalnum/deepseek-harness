import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suitePaths } from "../src/server/paths.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { home, directory } = suitePaths();
const profile = "research-suite";
const cli = join(
  root,
  "harness-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js",
);
const env = {
  ...process.env,
  DSH_HOME: home,
  DS_SUITE_HOME: home,
  DS_RESEARCH_DATA_DIR: directory,
};
function run(command, args, options = {}) {
  const windowsNpm = process.platform === "win32" && command === "npm.cmd";
  const result = spawnSync(
    windowsNpm ? process.env.ComSpec || "cmd.exe" : command,
    windowsNpm ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args,
    {
      cwd: root,
      env,
      stdio: "inherit",
      ...options,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(command + " failed: " + result.status);
}
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 14))
  throw new Error("Node.js 24.14+ required");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
run(npm, ["ci", "--no-audit", "--no-fund"]);
run(npm, ["run", "build"]);
run(npm, ["ci", "--prefix", "harness-runtime", "--no-audit", "--no-fund"]);
run(npm, ["test"]);
// Initialize only a new, dedicated profile. Never reset an existing profile.
if (!existsSync(join(home, "profiles", profile, "package.json")))
  run(
    process.execPath,
    [cli, profile, "--from-default-profile", "web", "--dump-config"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
run(process.execPath, [cli, "plugin", "--profile", profile, "add", root]);
console.log(
  "Installed in dedicated Harness home: " +
    home +
    "\nRun npm run start:all. Existing Harness settings were not changed.",
);
