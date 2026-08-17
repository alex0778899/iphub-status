#!/usr/bin/env node
// Turn the recorded probe history into a static status page.
//
// The page is deliberately boring. It publishes reachability and latency only.
// It must never publish which data sources answered a check, any source_trace
// field, or any per-request detail: those are internal forensic data.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;
const WINDOWS = [
  { label: "24 hours", ms: DAY_MS },
  { label: "7 days", ms: 7 * DAY_MS },
  { label: "30 days", ms: 30 * DAY_MS },
  { label: "90 days", ms: 90 * DAY_MS },
];

const config = JSON.parse(await readFile(join(ROOT, "targets.json"), "utf8"));

/** Read every month file back into one flat sample list. */
async function loadSamples() {
  let files = [];
  try {
    files = (await readdir(join(ROOT, "history"))).filter((name) =>
      name.endsWith(".jsonl"),
    );
  } catch {
    return [];
  }
  const samples = [];
  for (const file of files.sort()) {
    const text = await readFile(join(ROOT, "history", file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        samples.push(JSON.parse(line));
      } catch {
        // A truncated final line can happen if a runner is killed mid-append.
        // Skipping it is safer than failing the whole build.
      }
    }
  }
  return samples;
}

const samples = await loadSamples();
const now = Date.now();

/** Uptime over a window = successful samples / total samples in that window. */
function uptime(rows, windowMs) {
  const cutoff = now - windowMs;
  const inWindow = rows.filter((row) => Date.parse(row.t) >= cutoff);
  if (!inWindow.length) return null;
  const up = inWindow.filter((row) => row.ok).length;
  return (up / inWindow.length) * 100;
}

/** Median is used instead of mean so one slow sample cannot distort the number. */
function medianMs(rows, windowMs) {
  const cutoff = now - windowMs;
  const values = rows
    .filter((row) => Date.parse(row.t) >= cutoff && row.ok)
    .map((row) => row.ms)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  return values[Math.floor(values.length / 2)];
}

/** One bar per day for the last 90 days: null = no data collected that day. */
function dailyBars(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const day = row.t.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { up: 0, total: 0 });
    const bucket = byDay.get(day);
    bucket.total += 1;
    if (row.ok) bucket.up += 1;
  }
  const bars = [];
  for (let offset = 89; offset >= 0; offset -= 1) {
    const day = new Date(now - offset * DAY_MS).toISOString().slice(0, 10);
    const bucket = byDay.get(day);
    bars.push({ day, pct: bucket ? (bucket.up / bucket.total) * 100 : null });
  }
  return bars;
}

/** Measured gap between probe runs, so the page never claims a cadence it does not achieve.
 *
 * The workflow asks for every 5 minutes, but GitHub's scheduler is best-effort and
 * in practice delivers far fewer runs. Publishing the requested interval would be a
 * false claim on a page whose whole purpose is honest measurement, so this reports
 * what actually happened.
 */
function medianIntervalMinutes() {
  const stamps = [...new Set(samples.map((sample) => sample.t))].sort();
  if (stamps.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < stamps.length; i += 1) {
    gaps.push((Date.parse(stamps[i]) - Date.parse(stamps[i - 1])) / 60000);
  }
  gaps.sort((a, b) => a - b);
  return Math.round(gaps[Math.floor(gaps.length / 2)]);
}

const intervalMinutes = medianIntervalMinutes();

const services = config.targets.map((target) => {
  const rows = samples.filter((sample) => sample.id === target.id);
  const latest = rows.length ? rows[rows.length - 1] : null;
  return {
    id: target.id,
    name: target.name,
    current: latest ? (latest.ok ? "operational" : "down") : "no-data",
    latencyMs: medianMs(rows, DAY_MS),
    windows: WINDOWS.map((w) => ({ label: w.label, pct: uptime(rows, w.ms) })),
    bars: dailyBars(rows),
    samples: rows.length,
  };
});

const anyDown = services.some((service) => service.current === "down");
const anyData = services.some((service) => service.samples > 0);
const overall = !anyData ? "no-data" : anyDown ? "down" : "operational";
const firstSample = samples.length ? samples.map((s) => s.t).sort()[0] : null;

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const pct = (value) =>
  value === null ? "—" : `${value.toFixed(value >= 99.95 ? 3 : 2)}%`;

const barsHtml = (bars) =>
  bars
    .map((bar) => {
      const state =
        bar.pct === null
          ? "nodata"
          : bar.pct >= 99.95
            ? "good"
            : bar.pct >= 95
              ? "warn"
              : "bad";
      const title =
        bar.pct === null
          ? `${bar.day}: no data`
          : `${bar.day}: ${bar.pct.toFixed(2)}%`;
      return `<span class="bar ${state}" title="${escape(title)}"></span>`;
    })
    .join("");

const servicesHtml = services
  .map(
    (service) => `
      <section class="card">
        <header class="card-head">
          <h2>${escape(service.name)}</h2>
          <span class="pill ${service.current}">${service.current === "operational" ? "Operational" : service.current === "down" ? "Down" : "No data yet"}</span>
        </header>
        <dl class="metrics">
          ${service.windows.map((w) => `<div><dt>${escape(w.label)}</dt><dd>${pct(w.pct)}</dd></div>`).join("")}
          <div><dt>Median latency (24h)</dt><dd>${service.latencyMs === null ? "—" : `${service.latencyMs} ms`}</dd></div>
        </dl>
        <div class="bars" aria-label="Daily uptime, last 90 days">${barsHtml(service.bars)}</div>
        <p class="axis"><span>90 days ago</span><span>today</span></p>
      </section>`,
  )
  .join("");

const html = `<title>${escape(config.brand)} Status</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Measured uptime and latency for the ${escape(config.brand)} public APIs.">
<style>
  :root {
    --bg: #f7f8fa; --panel: #ffffff; --ink: #14161a; --muted: #5b6472; --line: #e3e6eb;
    --good: #17864a; --good-soft: #d8f0e2; --bad: #b3261e; --bad-soft: #fadcd9;
    --warn: #9a6a00; --warn-soft: #fdeec2; --nodata: #d6dae1;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0f1216; --panel: #171b21; --ink: #e8ebef; --muted: #97a1ae; --line: #262c34;
      --good: #4ade80; --good-soft: #14311f; --bad: #f87171; --bad-soft: #3a1614;
      --warn: #fbbf24; --warn-soft: #3a2d0c; --nodata: #2b323b;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0f1216; --panel: #171b21; --ink: #e8ebef; --muted: #97a1ae; --line: #262c34;
    --good: #4ade80; --good-soft: #14311f; --bad: #f87171; --bad-soft: #3a1614;
    --warn: #fbbf24; --warn-soft: #3a2d0c; --nodata: #2b323b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 820px; margin: 0 auto; padding: 48px 20px 64px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; letter-spacing: -0.01em; }
  .lede { color: var(--muted); margin: 0 0 28px; font-size: 0.95rem; }
  .overall {
    display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-radius: 12px;
    border: 1px solid var(--line); background: var(--panel); margin-bottom: 24px;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .overall.operational .dot { background: var(--good); }
  .overall.down .dot { background: var(--bad); }
  .overall.no-data .dot { background: var(--nodata); }
  .overall strong { font-weight: 600; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 18px; margin-bottom: 16px;
  }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .card-head h2 { font-size: 1rem; margin: 0; font-weight: 600; }
  .pill { font-size: 0.75rem; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .pill.operational { background: var(--good-soft); color: var(--good); }
  .pill.down { background: var(--bad-soft); color: var(--bad); }
  .pill.no-data { background: var(--nodata); color: var(--muted); }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 12px; margin: 0 0 16px; }
  .metrics dt { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  .metrics dd { margin: 2px 0 0; font-size: 1.05rem; font-variant-numeric: tabular-nums; }
  .bars { display: flex; gap: 2px; align-items: stretch; height: 34px; }
  .bar { flex: 1 1 0; min-width: 2px; border-radius: 2px; background: var(--nodata); }
  .bar.good { background: var(--good); }
  .bar.warn { background: var(--warn); }
  .bar.bad { background: var(--bad); }
  .axis { display: flex; justify-content: space-between; margin: 6px 0 0; font-size: 0.7rem; color: var(--muted); }
  footer { margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.82rem; }
  footer p { margin: 0 0 8px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
</style>
<div class="wrap">
  <h1>${escape(config.brand)} — Status</h1>
  <p class="lede">Measured from outside our infrastructure. No estimates, no marketing numbers.</p>

  <div class="overall ${overall}">
    <span class="dot"></span>
    <strong>${overall === "operational" ? "All systems operational" : overall === "down" ? "Service disruption in progress" : "Collecting first measurements"}</strong>
  </div>

  ${servicesHtml}

  <footer>
    <p><strong>How this is measured.</strong> A scheduled job on GitHub's infrastructure requests each public <code>/health</code> endpoint and records the result. The prober does not run on our servers, so it keeps reporting when our servers stop.</p>
    <p><strong>Honest limits.</strong> ${
      intervalMinutes === null
        ? "Sampling interval is still being measured."
        : `The job asks to run every 5 minutes, but the scheduler is best-effort and the <strong>measured interval is about ${intervalMinutes} minutes</strong> — that figure is calculated from this page's own history, not assumed. An outage shorter than one interval can be missed entirely.`
    } Uptime here is "share of successful samples", not a contractual measurement. We publish no uptime SLA today; when we do, it will be backed by this history and by finer-grained monitoring than this.</p>
    <p>Recording started ${firstSample ? escape(firstSample.slice(0, 10)) : "today"}. Page rebuilt ${escape(new Date(now).toISOString().replace("T", " ").slice(0, 16))} UTC.</p>
  </footer>
</div>
`;

await mkdir(join(ROOT, "docs"), { recursive: true });
await writeFile(join(ROOT, "docs", "index.html"), html, "utf8");
console.log(
  `built docs/index.html — ${samples.length} samples, overall=${overall}`,
);
