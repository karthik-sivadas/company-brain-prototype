# Testing the Slack bridge

Roughly 10 minutes, entirely free. Socket Mode means no public URL, no tunnel, no deployment.

## 1. Create a workspace (1 min)

<https://slack.com/get-started#/createnew> — any email works. Name it something like
`company-brain-test`. A free workspace is enough.

## 2. Create the app from the manifest (2 min)

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**
2. Pick your new workspace
3. Paste the contents of [`slack-app-manifest.yaml`](./slack-app-manifest.yaml) (switch the editor to YAML)
4. **Create**

The manifest already sets the scopes, events, Socket Mode and interactivity — nothing else to toggle.

## 3. Get the two tokens (2 min)

- **Bot token** — *OAuth & Permissions* → **Install to Workspace** → Allow → copy
  **Bot User OAuth Token** (`xoxb-…`)
- **App-level token** — *Basic Information* → **App-Level Tokens** → **Generate Token and Scopes**
  → name it `socket`, add the **`connections:write`** scope → **Generate** → copy (`xapp-…`)

## 4. Invite the bot to a channel (30 s)

In Slack: create `#brain-test`, then

```
/invite @Company Brain
```

## 5. Point the brain at it

```bash
cd company-brain-prototype
cat >> .env <<'ENV'
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ENV

set -a && source .env && set +a
bun run brain slack doctor      # both tokens ✓, docker ✓, image ✓
bun run brain slack start       # stays in the foreground
```

## 6. Test it

In `#brain-test`:

| # | What to send | What should happen |
|---|---|---|
| 1 | `@Company Brain how many GitHub issues are synced?` | ⏳ appears, then a threaded answer citing the parquet path, ⏳ → ✅ |
| 2 | **In that thread, with no @mention:** `and what is the newest one?` | It answers — proving follow-ups work without re-mentioning |
| 3 | In the same thread: `what did I ask you first?` | It recalls turn 1 — thread memory |
| 4 | Ask three questions at once in different threads | All answered; a queue notice if more than 4 run at once |
| 5 | DM the bot directly | Works without a mention |
| 6 | 👍 / 👎 on an answer | Logged by the bridge |

While it runs, check the sandboxes:

```bash
bun run brain slack threads             # thread → sandbox → turn count
docker ps --filter name=brain-thread    # one container per active thread
docker volume ls --filter name=brain-ws-thread
```

Leave a thread idle 15 minutes and its container is reaped — the volume stays, and the next
message in that thread still remembers the conversation.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_auth` on start | wrong or unset token | re-copy both tokens; bot token is `xoxb-`, app token `xapp-` |
| Bot silent on @mention | not in the channel | `/invite @Company Brain` |
| Follow-ups ignored | missing `channels:history` | reinstall after adding the scope |
| No ⏳ reaction | missing `reactions:write` | reinstall; answers still work |
| "No models available" in the answer | sandbox has no model credentials | check `~/.omp/agent` exists on the host |
| Answers twice | old bridge still running | kill the other process; one bridge per app token |
