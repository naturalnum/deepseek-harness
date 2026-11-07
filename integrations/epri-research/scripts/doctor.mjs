import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connection } from "../src/server/client.mjs";
import { suitePaths } from "../src/server/paths.mjs";
import { researchRunning, harnessRunning } from "./service-status.mjs";
import {engineStatus} from '../dist/server/engine-runtime.mjs';
import {documentStatus} from '../dist/server/document-runtime.mjs';
const root = fileURLToPath(new URL("../", import.meta.url));
const { home, directory } = suitePaths();
const checks = {
  node: process.version,
  harnessHome: home,
  researchDirectory: directory,
  harnessInstalled: existsSync(
    root + "harness-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js",
  ),
  profileInstalled: existsSync(home + "/profiles/research-suite/package.json"),
  backendBuilt: existsSync(root + "dist/server/main.mjs"),
  frontendBuilt: existsSync(root + "dist/ui/app.js"),
  harnessClientBuilt: existsSync(root + "dist/client.js"),
  copiedSkills: existsSync(
    root + "upstream/v2-main/resources/skills/science/SKILL.md",
  ),
};
try {
  const c = connection();
  await researchRunning(directory, c.url);
  const response = await fetch(c.url + "/health", {
    signal: AbortSignal.timeout(2000),
  });
  checks.service = await response.json();
} catch (e) {
  checks.service = { available: false, message: e.message };
}
try {
  checks.harness = {
    available: await harnessRunning(
      "http://127.0.0.1:" + (process.env.DS_HARNESS_PORT || "43128"),
    ),
  };
} catch (e) {
  checks.harness = { available: false, message: e.message };
}
checks.execution = await engineStatus();
checks.documents = await documentStatus().catch(error=>({available:false,message:error.message}));
console.log(JSON.stringify(checks, null, 2));
