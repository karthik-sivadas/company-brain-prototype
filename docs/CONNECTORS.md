# Configuring a connector

`pm` compiles **557 connectors** into the binary. This is how you turn one of them into data
the brain can answer from, and — where the connector supports it — a system it can write back to.

Everything here is host-side. Once a connector is configured, every sandbox can use it: pm's
project directory is mounted into each one, so a Slack thread started tomorrow inherits what
you configure today with no rebuild.

---

## 1. Find the connector and check what it can do

```bash
./bin/pm connectors list --json | jq -r '.connectors[].name' | grep -i <term>
./bin/pm connectors inspect <connector> --json | jq '.connector.capabilities'
```

```json
{ "check": true, "catalog": true, "read": true, "write": true, "query": false }
```

Read that before anything else. Capabilities differ sharply and the differences are not cosmetic:

| | `check` | `read` | `write` |
|---|---|---|---|
| `github` | ✓ | ✓ | ✓ (606 actions) |
| `twenty` | ✓ | ✓ | ✓ (112 actions) |
| `hubspot` | ✗ | ✓ | ✗ |

`read: false` means no sync is possible — the connector is declared but has no executable read
surface. Find that out now, not after you have configured it.

## 2. Get the field names from pm, never from guesswork

```bash
./bin/pm connectors inspect <connector> --json \
  | jq '.manifest.streams[] | {name, primary_key, cursor_fields}'
```

```json
{ "name": "issues",        "primary_key": ["node_id"], "cursor_fields": ["updated_at"] }
{ "name": "pull_requests", "primary_key": ["node_id"], "cursor_fields": ["updated_at"] }
```

**This is the step people skip, and it is the expensive one.** Guessing `id` for a GitHub
stream produces:

```
record is missing cursor field "undefined"
```

and **pm has no `connections delete`** — `pm connections` offers only `create` and `list`. A
connection built with the wrong key is permanent. Getting this right the first time is cheaper
than any recovery.

A stream with no `cursor_fields` cannot sync incrementally; it needs a full-refresh mode.

## 3. Supply the credential

Secrets are declared by the connector:

```bash
./bin/pm connectors inspect <connector> --json | jq '.manifest.secret_fields, .manifest.config_fields'
```

Put the value in `.env` (gitignored) and reference it by variable name — never inline:

```bash
# .env
TWENTY_API_KEY=...
```

```bash
./bin/pm --root data/pm credentials add twenty-prod \
  --connector twenty \
  --from-env api_key=TWENTY_API_KEY \
  --config base_url=https://crm.example.com
```

Then confirm it actually authenticates, rather than assuming:

```bash
./bin/pm --root data/pm credentials test twenty-prod --json
```

`--from-env` keeps the secret out of your shell history and out of `argv`. For multi-line
secrets such as a GitHub App private key, use `--value-stdin <field>`.

Unlike connections, credentials **can** be removed: `pm credentials remove <name>`.

### Where the secret ends up

pm encrypts it into `data/pm/.polymetrics/vault/`. Note honestly: **the vault's key sits beside
the ciphertext**, and that whole directory is mounted into every sandbox. That is what makes
"configure once, works in every thread" true — and it means any sandbox can read every
credential you configure. Fine while you are the only operator; scope credentials per use
before anyone else has access.

## 4. Declare it in `brain.config.json`

```json
{
  "connectors": [
    {
      "connector": "github",
      "credential": "gh",
      "config": { "owner": "polymetrics-ai", "repo": "cli", "auth_type": "public", "max_pages": "1" },
      "streams": [
        { "name": "issues", "primaryKey": "node_id", "cursor": "updated_at", "table": "gh_issues" }
      ]
    }
  ]
}
```

`primaryKey` and `cursor` are the values from step 2. `table` is what the Parquet file is
called and what the agent will cite.

## 5. Create and run it

```bash
bun run brain setup     # creates credentials and connections from the config
bun run brain sync      # runs the ETL
bun run brain tables    # what landed
```

`setup` is idempotent — existing connections report "already present". `sync` re-runs
incrementally where the stream declares a cursor.

Both regenerate `brain/skills/brain-search/SKILL.md` and `brain/DATA-STATE.md`, which is how
the agent learns the new table exists. Skip them and the agent will correctly report that it
has no such data.

## 6. Check the agent can see it

```bash
bun run brain tables
grep -A6 '^## <connector>' brain/DATA-STATE.md
```

`DATA-STATE.md` shows configured streams against extracted ones, and lists what else the same
credential could reach. That last part matters: the agent reads it, so a stream listed there
can be pulled on request without you configuring anything.

---

## Adding a stream later — you usually don't have to

Once a connector is configured, **just ask the brain**. It reads pm's manifest for the right
key and cursor, creates the connection, runs the sync, and answers:

> *"Releases are not synced. I'm starting the configured GitHub extraction."*
> → 4 releases, cited from `github_releases.parquet`

That covers every stream the connector declares — 37 for GitHub, of which 3 are synced here.

## Writes

Connectors with `write: true` can be written back to, always behind approval. The agent may
plan and preview; it can never approve — `pm` omits the approval token from `--json` output
specifically so an agent cannot authorise its own mutation. A person approves in Slack, and
destructive operations additionally require typing `destructive`.

See `docs/slack-setup.md` for the approval flow.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Connector silently absent after `setup` | A `fromEnv` variable is unset. pm skips the connector rather than failing. Check `.env`. |
| `record is missing cursor field "undefined"` | `cursor` missing or wrong. Take it from the manifest (step 2). The connection is now permanent — use a new name. |
| `write action "upsert" not found in bundle` | That connector has no generic upsert. Use its named command: `pm <connector> <group> <cmd>`. |
| `missing --credential` | Ad-hoc connector commands need `--credential <name>` explicitly. |
| Agent says data is missing that you synced | `brain sync` regenerates the skill and DATA-STATE; if you ran pm directly, run `bun run brain skills`. |
