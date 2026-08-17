#!/usr/bin/env node
// Probe every configured target once and append one JSON line per target to the
// month's history file. Runs on GitHub's runners, deliberately outside our own
// infrastructure: a prober living on the box it watches cannot report that box dying.
//
// Only plain /health endpoints are probed. /health/detailed reports database and
// cache state, which must never become a public readout.

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 10_000;

/** Fetch one target, measuring wall-clock latency. Never throws. */
async function probe(target) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(target.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "ip-intel-status-probe/1" },
    });
    return {
      id: target.id,
      ok: response.status >= 200 && response.status < 400,
      code: response.status,
      ms: Date.now() - started,
    };
  } catch (error) {
    // A timeout and a refused connection are both "down" to a customer.
    return {
      id: target.id,
      ok: false,
      code: 0,
      ms: Date.now() - started,
      error:
        error.name === "AbortError"
          ? "timeout"
          : String(error.cause?.code || error.name),
    };
  } finally {
    clearTimeout(timer);
  }
}

const config = JSON.parse(await readFile(join(ROOT, "targets.json"), "utf8"));
const stamp = new Date().toISOString();
const results = await Promise.all(config.targets.map(probe));

const month = stamp.slice(0, 7); // YYYY-MM
const historyFile = join(ROOT, "history", `${month}.jsonl`);
await mkdir(dirname(historyFile), { recursive: true });

const lines = results
  .map((result) => JSON.stringify({ t: stamp, ...result }))
  .join("\n");
await appendFile(historyFile, lines + "\n", "utf8");

for (const result of results) {
  console.log(
    `${result.ok ? "up  " : "DOWN"} ${result.id} code=${result.code} ${result.ms}ms${result.error ? ` (${result.error})` : ""}`,
  );
}
