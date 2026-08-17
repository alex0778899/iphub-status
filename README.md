# IP Intelligence Platform — public status page

Measured uptime for the public `iphub.live` APIs. Published at the GitHub Pages URL of this repository.

## Why this repository is separate

The prober must not run on the infrastructure it watches. A monitor living on the same VPS as the API cannot report that the VPS died — it dies with it. So the probe runs on GitHub's runners and the page is served by GitHub Pages, both outside our own infrastructure. This repository contains no product source code.

## How it works

1. `.github/workflows/probe.yml` runs every 5 minutes.
2. `scripts/probe.mjs` requests each URL in `targets.json` and appends one JSON line per target to `history/YYYY-MM.jsonl`.
3. `scripts/build.mjs` recomputes uptime windows and rewrites `docs/index.html`.
4. The workflow commits both, and GitHub Pages serves `docs/`.

No dependencies, no build step, no external services.

## What it deliberately does not publish

Only reachability and latency. Never which data sources answered a check, never `source_trace`, never any per-request detail — that information is internal forensic data.

Probes target the plain `/health` endpoints only. `/health/detailed` names internal dependencies and must never be the subject of a public page.

## Known measurement limits

- **5-minute sampling.** An outage shorter than one interval can be missed entirely. Uptime here is "share of successful samples", not a contractual measurement.
- **GitHub's scheduler is best-effort.** Runs can be delayed under load, so intervals are not exactly 5 minutes.
- Good enough to earn a public uptime claim; not good enough to underwrite a paid SLA. That would need a sub-minute commercial monitor from multiple regions.

## Running it locally

```bash
node scripts/probe.mjs   # take one measurement
node scripts/build.mjs   # rebuild docs/index.html from history
```

Requires Node 18 or newer for the built-in `fetch`.

## Changing what is monitored

Edit `targets.json`. Each entry needs `id` (stable — it keys the history), `name` (shown on the page), and `url`. Removing a target keeps its recorded history but drops it from the page.
