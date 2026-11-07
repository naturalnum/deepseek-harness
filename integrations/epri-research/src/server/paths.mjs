import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const suiteRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function suitePaths({
  env = process.env,
  root = suiteRoot,
  userHome = homedir(),
  exists = existsSync,
} = {}) {
  const legacy = join(userHome, ".deepscientist-harness");
  const choose = (override, name, oldName, marker) => {
    if (override) return resolve(override);
    const local = join(root, ".data", name);
    const old = join(legacy, oldName);
    return exists(join(local, marker))
      ? local
      : exists(join(old, marker))
        ? old
        : local;
  };
  return {
    home: choose(
      env.DS_SUITE_HOME,
      "harness-home",
      "harness-home",
      "profiles/research-suite/package.json",
    ),
    directory: choose(
      env.DS_RESEARCH_DATA_DIR,
      "research",
      "local-research",
      "connection.json",
    ),
  };
}
