import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../dist/server/main.mjs";
import { suitePaths, suiteRoot as root } from "../src/server/paths.mjs";
import { researchRunning, harnessRunning } from "./service-status.mjs";
const { home, directory } = suitePaths();
const cli = join(
  root,
  "harness-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js",
);
const harnessPort = process.env.DS_HARNESS_PORT || "43128";
const harnessUrl = "http://127.0.0.1:" + harnessPort;
const [researchReady, harnessReady] = await Promise.all([
  researchRunning(directory),
  harnessRunning(harnessUrl),
]);
if (
  !harnessReady &&
  (!existsSync(cli) ||
    !existsSync(join(home, "profiles/research-suite/package.json")))
)
  throw new Error("Run node scripts/install.mjs first");
const app = researchReady
  ? null
  : await startServer({ directory, port: 43127 });
const child = harnessReady
  ? null
  : spawn(
      process.execPath,
      [cli, "research-suite", "--no-open", "--port", harnessPort],
      {
        cwd: root,
        env: {
          ...process.env,
          DSH_HOME: home,
          DS_SUITE_HOME: home,
          DS_RESEARCH_DATA_DIR: directory,
        },
        stdio: "inherit",
      },
    );
const lifecycle = (message) => console.error(`[${new Date().toISOString()}] ${message}`);
lifecycle(`Service launcher started pid=${process.pid}; Harness child=${child?.pid ?? 'reused'}; research=${app ? 'started' : 'reused'}`);
process.on('exit', (code) => lifecycle(`Service launcher exiting code=${code}`));
process.on('uncaughtExceptionMonitor', (error) => lifecycle(`Uncaught exception: ${error.name}; code=${error.code ?? 'unknown'}`));
console.log(
  `Research sidebar: ${harnessUrl}/research/ (private backend ${researchReady ? "reused" : "started"})\n` +
    `Harness: ${harnessUrl}/ (${harnessReady ? "already running" : "starting"})\n` +
    "Research uses the authenticated Harness browser. No separate research login or key is required.",
);
let shuttingDown = false;
async function finish() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app?.close();
}
child?.once("error", async (e) => {
  lifecycle(`Harness spawn failed code=${e.code ?? 'unknown'}`);
  console.error(e.message);
  await finish();
  process.exitCode = 1;
});
child?.once("exit", async (code, signal) => {
  const expected = shuttingDown;
  lifecycle(`Harness exited code=${code ?? 'none'} signal=${signal ?? 'none'} expected=${expected}`);
  await finish();
  process.exitCode = code ?? (expected ? 0 : 1);
});
if (app || child)
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      lifecycle(`Service launcher received ${signal}`);
      if (!shuttingDown) {
        child?.kill("SIGTERM");
        void finish();
      }
    });
