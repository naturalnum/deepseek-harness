import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServer } from "../dist/server/main.mjs";
import { contracts } from "../src/server/contracts.mjs";
test("real MCP SDK handshake, tools/list and HTTP-shared read/write; authorization fence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-research-"));
  const app = await startServer({ directory: dir, port: 0 });
  const client = new Client({ name: "acceptance", version: "1" });
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/server/mcp.mjs")],
      env: { ...process.env, DS_RESEARCH_DATA_DIR: dir },
      stderr: "pipe",
    });
    await client.connect(transport);
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(t => t.name).sort(), Object.keys(contracts).map(op => "research_" + op).sort());
    const call = async (name, args) => {
      const r = await client.callTool({
        name: "research_" + name,
        arguments: args,
      });
      assert.equal(r.isError, undefined, JSON.stringify(r));
      return JSON.parse(r.content[0].text);
    };
    await call("protocol_put", {
      id: "mcp-test",
      version: "1",
      content: `# MCP protocol

{{var|result: str, owner="agent"}}`,
      requestId: "p1",
    });
    let r = await call("record_create", {
      protocolId: "mcp-test",
      protocolVersion: "1",
      requestId: "c1",
    });
    r = await call("record_update", {
      id: r.id,
      expectedRevision: 1,
      requestId: "u1",
      run: {
        ...r.run,
        status: "running",
        values: { result: "real MCP write" },
      },
    });
    const denied = await client.callTool({ name: "research_record_submit", arguments: { id: r.id, expectedRevision: r.revision, requestId: "submit-denied" } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /FORBIDDEN/);
    const response = await fetch(app.url + "/api", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + app.credentials.humanToken,
      },
      body: JSON.stringify({ op: "record_get", args: { id: r.id } }),
    });
    assert.equal(
      (await response.json()).result.run.values.result,
      "real MCP write",
    );
    assert.equal(
      (await fetch(app.url + "/api", { method: "POST", body: "{}" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(app.url + "/api", {
          method: "POST",
          headers: {
            Origin: "https://untrusted.example",
            Authorization: "Bearer " + app.credentials.humanToken,
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await fetch(app.url + "/connection.json")).status, 404);
  } finally {
    await client.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
