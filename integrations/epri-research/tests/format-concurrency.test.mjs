import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import { startServer } from "../dist/server/main.mjs";
test("concurrent HTTP CAS admits exactly one write; exports pass official Airalogy JSON schema", async () => {
  const directory = mkdtempSync(join(tmpdir(), "concurrency-test-"));
  const app = await startServer({ directory, port: 0 });
  try {
    const call = async (op, args) => {
      const response = await fetch(app.url + "/api", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + app.credentials.agentToken,
        },
        body: JSON.stringify({ op, args }),
      });
      return { status: response.status, ...(await response.json()) };
    };
    await call("protocol_put", {
      id: "p",
      version: "1",
      content: '# Concurrent protocol\n\n{{var|answer: str, owner="agent"}}',
      requestId: "p",
    });
    const { result: r } = await call("record_create", {
      protocolId: "p",
      protocolVersion: "1",
      requestId: "c",
    });
    const results = await Promise.all(
      ["A", "B"].map((answer) =>
        call("record_update", {
          id: r.id,
          expectedRevision: 1,
          requestId: answer,
          run: { ...r.run, status: "running", values: { answer } },
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const { result: exported } = await call("record_export", { id: r.id });
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(
      JSON.parse(
        readFileSync("upstream/airalogy/schemas/aira/record.v1.schema.json"),
      ),
    );
    assert.equal(validate(exported), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...exported, data: { var: [] } }), false);
    const spoof = await call("state", { actor: "human" });
    assert.equal(spoof.status, 400);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
