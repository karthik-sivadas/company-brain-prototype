---
name: brain-setup
description: Set up, extend or repair the Company Brain. Use when asked to add a data source or connector, install or move skills, run an extraction, diagnose why the brain has no data, or bootstrap the brain from scratch.
---

# brain-setup

The brain has two halves. **`pm`** extracts data into a Parquet warehouse. **You (OMP)** reason
over it. Skills live in `brain/skills/`, which is symlinked to `.omp/skills/` so you discover them.

Never improvise shell for these tasks — call the CLI, which is deterministic and idempotent.

## Commands

```bash
bun run brain doctor            # check prerequisites; run this first when something is wrong
bun run brain setup             # full bootstrap (safe to re-run)
bun run brain skills            # regenerate + transport skills into brain/skills
bun run brain sync [connector]  # extract into the warehouse
bun run brain tables            # list queryable Parquet tables
```

## Adding a data source

1. Confirm the connector exists: `bin/pm connectors list --json` (557 are built in — GitHub,
   Slack, Notion, Linear, Jira, Confluence, Gmail, PostHog, Stripe, Salesforce …).
2. Inspect its streams and required config:
   `bin/pm connectors inspect <slug> --json`
3. Add an entry to `brain.config.json` under `connectors`:

```json
{
  "connector": "slack",
  "credential": "slack",
  "config": {},
  "fromEnv": { "token": "SLACK_BOT_TOKEN" },
  "streams": [
    { "name": "channel_messages", "primaryKey": "ts", "cursor": "ts", "table": "slack_messages" }
  ]
}
```

4. Add its `pm-<slug>` skill to `activeSkills` in the same file.
5. Run `bun run brain setup` then `bun run brain sync <connector>`.

Secrets go in `fromEnv` only — pm reads them from the environment. **Never write a secret into
`brain.config.json`.**

## Rules

- Every `pm` call must run from `data/pm/` — pm creates `.polymetrics/` in the working directory.
- A sync reporting `failed` with `"page budget"` in the error is fine: rows were committed;
  `max_pages` stopped it. Raise `max_pages` to `all` for a complete pull.
- After any sync, run `bun run brain skills` so `brain-search` lists the new tables.
- Public GitHub needs `auth_type=public` **and** `rate_limit_ip`.
