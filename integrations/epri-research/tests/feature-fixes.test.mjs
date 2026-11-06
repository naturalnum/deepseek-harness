import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { openStore } from "../dist/server/service.mjs";
import { startServer } from "../dist/server/main.mjs";

test("human review is enforced for HTTP and direct callers; archive restoration retains history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "research-review-"));
  const app = await startServer({ directory, port: 0 });
  const call = async (op, args = {}, actor = "human") => {
    const response = await fetch(app.url + "/api", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + app.credentials[actor + "Token"] }, body: JSON.stringify({ op, args }) });
    return { status: response.status, ...await response.json() };
  };
  const write = (op, args, actor) => call(op, { ...args, requestId: randomUUID() }, actor);
  try {
    assert.equal((await write("protocol_put", { id: "review", version: "1", content: '# Review\n\n{{var|answer: str, owner="agent"}}\n\n{{check|reviewed, title="Human review"}}' })).status, 200);
    let { result: r } = await write("record_create", { protocolId: "review", protocolVersion: "1" });
    assert.equal((await write("record_update", { id: r.id, expectedRevision: r.revision, run: { ...r.run, status: "running", values: { answer: "v1" }, checks: { reviewed: true } } }, "agent")).status, 403);
    r = (await write("record_update", { id: r.id, expectedRevision: r.revision, run: { ...r.run, status: "running", values: { answer: "v1" } } }, "agent")).result;
    r = (await write("record_update", { id: r.id, expectedRevision: r.revision, run: { ...r.run, checks: { reviewed: true } } })).result;
    assert.equal((await write("record_update", { id: r.id, expectedRevision: r.revision, run: { ...r.run, checks: {} } }, "agent")).status, 403);
    r = (await write("record_update", { id: r.id, expectedRevision: r.revision, run: { ...r.run, values: { answer: "changed after review" } } }, "agent")).result;
    assert.equal(r.run.checks.reviewed, false);
    assert.equal((await write("record_submit", { id: r.id, expectedRevision: r.revision })).status, 400);
    r = (await write("record_update", { id: r.id, expectedRevision: r.revision, run: { ...r.run, checks: { reviewed: true } } })).result;
    for (const op of ["record_submit", "record_reopen", "record_archive", "record_restore"]) {
      const args = { id: r.id, expectedRevision: r.revision, ...(op === "record_submit" ? {} : { reason: "agent attempt" }) };
      assert.equal((await write(op, args, "agent")).status, 403, op);
    }
    r = (await write("record_submit", { id: r.id, expectedRevision: r.revision })).result;
    assert.equal(r.history.length, 1);
    r = (await write("record_archive", { id: r.id, expectedRevision: r.revision, reason: "test archive" })).result;
    assert.equal((await call("state")).result.records.length, 0);
    assert.equal((await call("state", { includeArchived: true })).result.records[0].archived, true);
    assert.equal((await write("record_restore", { id: r.id, expectedRevision: r.revision - 1, reason: "stale" })).status, 409);
    r = (await write("record_restore", { id: r.id, expectedRevision: r.revision, reason: "recover" })).result;
    assert.equal(r.archived, false); assert.equal(r.status, "submitted"); assert.equal(r.history.length, 1);
    assert.equal(r.audit.at(-1).action, "record_restore");
    r = (await write("record_reopen", { id: r.id, expectedRevision: r.revision, reason: "new measurements" })).result;
    assert.equal(r.run.checks.reviewed, false);
    assert.equal((await call("state")).result.records.length, 1);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("real date/time and immutable attachment validation, persistence and retrieval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "research-files-"));
  let store = openStore(directory);
  const write = (op, args, actor = "human") => store.execute(op, { ...args, requestId: randomUUID() }, actor);
  try {
    await write("protocol_put", { id: "files", version: "1", content: '# Files\n\n{{var|day: date}}\n\n{{var|at: datetime}}\n\n{{var|attachment: file}}' });
    let r = await write("record_create", { protocolId: "files", protocolVersion: "1" });
    const bytes = Buffer.from("actual measurement\n12.3\n");
    const put = { name: "measurement.csv", contentBase64: bytes.toString("base64"), requestId: "same-upload" };
    const a = await store.execute("attachment_put", put, "human");
    assert.deepEqual(await store.execute("attachment_put", put, "human"), a);
    assert.equal(a.reference, "attachment:" + createHash("sha256").update(bytes).digest("hex"));
    const valid = { day: "2024-02-29", at: "2024-02-29T23:59:59+08:00", attachment: a.reference };
    for (const invalid of [
      { day: "not-a-date" }, { day: "2023-02-29" }, { day: "2024-02-30" }, { day: "2024-13-01" }, { day: "0000-01-01" },
      { at: "2024-02-29" }, { at: "2024-02-29T24:00" }, { at: "2024-02-29T23:60" }, { at: "2024-02-30T12:00:00Z" },
      { attachment: "missing.pdf" }, { attachment: "attachment:" + "0".repeat(64) },
    ]) await assert.rejects(write("record_update", { id: r.id, expectedRevision: r.revision, run: { ...r.run, status: "running", values: { ...valid, ...invalid } } }), e => e.code === "INVALID", JSON.stringify(invalid));
    for (const bad of [{ name: "../escape", contentBase64: "" }, { name: "a", contentBase64: "!!!!" }, { name: "a", contentBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") }])
      await assert.rejects(write("attachment_put", bad), e => e.code === "INVALID");
    r = await write("record_update", { id: r.id, expectedRevision: r.revision, run: { ...r.run, status: "running", values: { ...valid, at: "2024-02-29T12:30" } } });
    r = await write("record_submit", { id: r.id, expectedRevision: r.revision });
    assert.equal(r.status, "submitted");
    store.close(); store = openStore(directory);
    const read = await store.execute("attachment_get", { reference: a.reference });
    assert.deepEqual(Buffer.from(read.contentBase64, "base64"), bytes);
    assert.equal(read.name, "measurement.csv");
    assert.equal((await store.execute("record_get", { id: r.id })).run.values.attachment, a.reference);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("aborting an HTTP literature request cancels the provider, with no external network", { timeout: 8000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "research-cancel-"));
  const app = await startServer({ directory, port: 0 });
  const originalFetch = globalThis.fetch;
  let started, stopped;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const providerStopped = new Promise(resolve => { stopped = resolve; });
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith(app.url)) return originalFetch(url, options);
    assert.match(String(url), /^https:\/\/api\.crossref\.org\//);
    assert.ok(options.signal);
    started();
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => { stopped(); reject(new DOMException("Cancelled", "AbortError")); }, { once: true }));
  };
  const controller = new AbortController();
  try {
    const pending = fetch(app.url + "/api", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + app.credentials.agentToken }, body: JSON.stringify({ op: "literature_search", args: { query: "local cancellation test", source: "crossref" } }), signal: controller.signal });
    const rejected = assert.rejects(pending, e => e.name === "AbortError");
    await providerStarted; controller.abort(); await rejected; await providerStopped;
  } finally { globalThis.fetch = originalFetch; controller.abort(); await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('online provider challenges and rate limits give actionable errors instead of empty or stale success',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'literature-errors-')),store=openStore(directory),originalFetch=globalThis.fetch;
 try{
  for(const [source,status,type,body,message] of [['dblp',202,'text/html','<!doctype html><title>Human verification</title>',/人机验证/],['semantic_scholar',429,'application/json','{}',/限流/]]){
   globalThis.fetch=async()=>new Response(body,{status,headers:{'Content-Type':type}});
   await assert.rejects(store.execute('literature_search',{query:'synthetic provider response',source,max_results:1},'agent',undefined,'isolated'),e=>e.code==='PROVIDER'&&message.test(e.message));
  }
 }finally{globalThis.fetch=originalFetch;store.close();rmSync(directory,{recursive:true,force:true});}
});
