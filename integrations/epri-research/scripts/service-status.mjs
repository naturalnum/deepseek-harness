import { readFileSync } from "node:fs";
import { join } from "node:path";

async function request(url, options = {}) {
  try {
    return await fetch(url, {
      ...options,
      headers: { Connection: "close", ...options.headers },
      signal: AbortSignal.timeout(2500),
    });
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return null;
    throw new Error(`Cannot check ${url}: ${error.message}`);
  }
}

export async function researchRunning(
  directory,
  url = "http://127.0.0.1:43127",
) {
  const health = await request(url + "/health");
  if (!health) return false;
  const body = await health.json().catch(() => null);
  if (!health.ok || body?.service !== "deepscientist-harness-suite")
    throw new Error(`Port occupied by another service: ${url}`);
  const credentials = JSON.parse(
    readFileSync(join(directory, "connection.json"), "utf8"),
  );
  const response = await request(url + "/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + credentials.agentToken,
    },
    body: JSON.stringify({ op: "state", args: {} }),
  });
  if (!response?.ok || !(await response.json()).result)
    throw new Error(
      `Research service does not match the selected data directory: ${directory}`,
    );
  return true;
}

export async function harnessRunning(url = "http://127.0.0.1:43128") {
  const response = await request(url + "/");
  if (!response) return false;
  if (
    response.status !== 401 ||
    (await response.text()).trim() !==
      "dsh web authentication required; reopen the URL printed by dsh web."
  )
    throw new Error(`Port occupied by another service: ${url}`);
  return true;
}
