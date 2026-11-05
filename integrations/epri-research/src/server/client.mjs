import { readFileSync } from "node:fs";
import { join } from "node:path";
import { suitePaths } from "./paths.mjs";
export function connection() {
  const dir = suitePaths().directory;
  return JSON.parse(readFileSync(join(dir, "connection.json"), "utf8"));
}
export async function call(op, args = {}, signal, sessionId = null) {
  const c = connection();
  const response = await fetch(c.url + "/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + c.agentToken,
    },
    body: JSON.stringify({ op, args, sessionId }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error((data.code || response.status) + ": " + data.error);
  return data.result;
}
