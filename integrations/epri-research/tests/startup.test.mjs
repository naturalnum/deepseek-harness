import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suitePaths } from "../src/server/paths.mjs";
import { researchRunning, harnessRunning } from "../scripts/service-status.mjs";

test("suite paths preserve overrides, local deployment, and legacy home", () => {
  const root = join(tmpdir(), "suite"),
    userHome = join(tmpdir(), "user");
  const local = join(root, ".data"),
    legacy = join(userHome, ".deepscientist-harness");
  const options = { root, userHome, env: {}, exists: () => false };
  assert.deepEqual(suitePaths(options), {
    home: join(local, "harness-home"),
    directory: join(local, "research"),
  });
  assert.deepEqual(
    suitePaths({ ...options, exists: (p) => p.startsWith(legacy) }),
    {
      home: join(legacy, "harness-home"),
      directory: join(legacy, "local-research"),
    },
  );
  assert.deepEqual(suitePaths({ ...options, exists: () => true }), {
    home: join(local, "harness-home"),
    directory: join(local, "research"),
  });
  const override = suitePaths({
    ...options,
    env: { DS_SUITE_HOME: root, DS_RESEARCH_DATA_DIR: userHome },
    exists: () => true,
  });
  assert.deepEqual(override, { home: root, directory: userHome });
});

test("service reuse rejects unrelated services and wrong research credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "suite-startup-"));
  writeFileSync(
    join(directory, "connection.json"),
    JSON.stringify({ agentToken: "test-agent" }),
  );
  let kind = "unrelated";
  const server = http.createServer((req, res) => {
    if (kind === "harness") {
      res.writeHead(401);
      return res.end(
        "dsh web authentication required; reopen the URL printed by dsh web.\n",
      );
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health")
      return res.end(
        JSON.stringify({
          service:
            kind === "unrelated" ? "other" : "deepscientist-harness-suite",
        }),
      );
    if (
      kind === "research" &&
      req.headers.authorization === "Bearer test-agent"
    )
      return res.end(
        JSON.stringify({ result: { protocols: [], records: [] } }),
      );
    res.writeHead(401);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  try {
    await assert.rejects(researchRunning(directory, url), /another service/);
    await assert.rejects(harnessRunning(url), /another service/);
    kind = "wrong-workspace";
    await assert.rejects(
      researchRunning(directory, url),
      /selected data directory/,
    );
    kind = "research";
    assert.equal(await researchRunning(directory, url), true);
    kind = "harness";
    assert.equal(await harnessRunning(url), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(await harnessRunning(url), false);
  assert.equal(await researchRunning(directory, url), false);
});
