import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../dist/server/service.mjs";
const source = `# Test protocol

{{var|question: str, owner="human"}}

{{var|answer: str, owner="agent"}}

{{step|verify, title="Review evidence", check=True}}`;
const rid = () => randomUUID();
test("durable records, ownership, revisions, idempotency, amendments and archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-test-"));
  let s = openStore(dir);
  try {
    await s.execute(
      "protocol_put",
      { id: "p", version: "1", content: source, requestId: rid() },
      "human",
    );
    await assert.rejects(
      () =>
        s.execute(
          "protocol_put",
          { id: "p", version: "1", content: source, requestId: rid() },
          "human",
        ),
      /immutable/,
    );
    const create = { protocolId: "p", protocolVersion: "1", requestId: rid() };
    let r = await s.execute("record_create", create, "human");
    assert.equal((await s.execute("record_create", create, "human")).id, r.id);
    await assert.rejects(
      () =>
        s.execute(
          "record_create",
          { ...create, protocolVersion: "2" },
          "human",
        ),
      /Idempotency/,
    );
    await assert.rejects(
      () =>
        s.execute(
          "record_update",
          {
            id: r.id,
            expectedRevision: 1,
            requestId: rid(),
            run: {
              ...r.run,
              status: "running",
              values: { question: "unauthorized" },
            },
          },
          "agent",
        ),
      /owned by human/,
    );
    r = await s.execute(
      "record_update",
      {
        id: r.id,
        expectedRevision: 1,
        requestId: rid(),
        run: {
          ...r.run,
          status: "running",
          values: { question: "Does it replicate?" },
        },
      },
      "human",
    );
    await assert.rejects(
      () =>
        s.execute(
          "record_submit",
          { id: r.id, expectedRevision: r.revision, requestId: rid() },
          "human",
        ),
      /Required fields/,
    );
    await assert.rejects(
      () =>
        s.execute(
          "record_update",
          { id: r.id, expectedRevision: 1, requestId: rid(), run: r.run },
          "human",
        ),
      /Revision changed/,
    );
    r = await s.execute(
      "record_update",
      {
        id: r.id,
        expectedRevision: r.revision,
        requestId: rid(),
        run: {
          ...r.run,
          values: { ...r.run.values, answer: "Measured replication confirmed" },
          steps: { verify: true },
        },
      },
      "agent",
    );
    r = await s.execute(
      "record_submit",
      { id: r.id, expectedRevision: r.revision, requestId: rid() },
      "human",
    );
    assert.equal(r.status, "submitted");
    assert.equal(r.history.length, 1);
    await assert.rejects(
      () =>
        s.execute(
          "record_update",
          {
            id: r.id,
            expectedRevision: r.revision,
            requestId: rid(),
            run: r.run,
          },
          "human",
        ),
      /Reopen/,
    );
    const exported = await s.execute("record_export", { id: r.id });
    assert.equal(exported.format, "airalogy.record");
    assert.deepEqual(exported.data.step.verify, {
      checked: true,
      annotation: "",
    });
    assert.equal(exported.data.var.question, "Does it replicate?");
    s.close();
    s = openStore(dir);
    assert.equal(
      (await s.execute("record_get", { id: r.id })).status,
      "submitted",
    );
    r = await s.execute(
      "record_reopen",
      {
        id: r.id,
        expectedRevision: r.revision,
        requestId: rid(),
        reason: "Independent replication",
      },
      "human",
    );
    assert.equal(r.history[0].run.status, "completed");
    assert.equal(r.status, "draft");
    r = await s.execute(
      "record_archive",
      {
        id: r.id,
        expectedRevision: r.revision,
        requestId: rid(),
        reason: "Superseded",
      },
      "human",
    );
    assert.equal((await s.execute("state")).records.length, 0);
    assert.equal((await s.execute("record_get", { id: r.id })).archived, true);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("copied chart schema and SVG renderer preserve plotted labels and values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chart-test-"));
  const s = openStore(dir);
  try {
    const a = await s.execute("chart_render", {
      requestId: rid(),
      spec: {
        schema: "deepscientist.report_chart.v1",
        kind: "bar",
        title: "Replication comparison",
        data: [
          { id: "baseline", label: "Baseline", value: 12 },
          { id: "candidate", label: "Candidate", value: 18 },
        ],
      },
    });
    assert.match(a.svg, /<svg/);
    assert.match(a.svg, /Baseline/);
    assert.equal((await s.execute("state")).artifacts.length, 1);
    await assert.rejects(() =>
      s.execute("chart_render", {
        requestId: rid(),
        spec: { kind: "invented" },
      }),
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("default values, integer bounds, unknown fields and immutable system ownership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "types-test-"));
  const s = openStore(dir);
  try {
    await s.execute(
      "protocol_put",
      {
        id: "typed",
        version: "1",
        content:
          '# Typed protocol\n\n{{var|count: int = 3, owner="human", ge=0}}\n\n{{var|stamp: str = "fixed", owner="system"}}',
        requestId: rid(),
      },
      "human",
    );
    let r = await s.execute(
      "record_create",
      { protocolId: "typed", protocolVersion: "1", requestId: rid() },
      "human",
    );
    assert.equal(r.run.values.count, 3);
    assert.equal(r.run.values.stamp, "fixed");
    for (const values of [
      { count: 1.5, stamp: "fixed" },
      { count: -1, stamp: "fixed" },
      { count: 3, stamp: "changed" },
      { count: 3, stamp: "fixed", unexpected: 1 },
    ])
      await assert.rejects(() =>
        s.execute(
          "record_update",
          {
            id: r.id,
            expectedRevision: r.revision,
            requestId: rid(),
            run: { ...r.run, status: "running", values },
          },
          "human",
        ),
      );
    assert.equal((await s.execute("record_get", { id: r.id })).revision, 1);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
