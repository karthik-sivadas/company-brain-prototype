**To:** jofin@needletailai.com
**Subject:** Company Brain — working prototype, and what I'd need to make it yours

Hi Jofin,

I built the Company Brain prototype. It's live and the code is public:
https://github.com/karthik-sivadas/company-brain-prototype

**What it does today.** You ask a question in Slack. A container spins up for that thread, an
agent queries a local Parquet warehouse with DuckDB, and answers with a citation to the exact
file it read. If the data isn't there yet, it says so, extracts it, and then answers. If you
ask it to change something in an external system, it doesn't — it posts an approval card and
waits for a person.

Three things I verified rather than assumed, because the difference matters:

- Asked for release counts with nothing synced, it replied *"Releases are not synced. I'm
  starting the configured GitHub extraction"*, created the connection, ran the sync, and
  answered: 4 releases, cited.
- A thread keeps its memory even after its container is destroyed — I killed the container
  between turns and the conversation continued.
- End to end against a real GitHub account: created a private repo, created an issue, closed
  it, deleted it. Every step through an approval gate. Deleting additionally required typing
  "destructive" — the agent literally cannot approve its own writes, because pm withholds the
  approval token from machine-readable output.

**How it's built — this is the actual argument.** I wrote no agent runtime, no vector
database, and no application server. `pm` (Polymetrics CLI) owns extraction: cursors,
deduplication, tombstones, a run ledger, approval-gated writes. `omp` owns the agent loop.
DuckDB queries Parquet in place. Docker provides isolation. The repo is roughly 3,300 lines of
glue between them.

That's why it exists at all: **6 hours, 24 commits** — 16:13 to 22:31 in one sitting. Not
because I write fast, but because almost none of it was written.

**557 connectors** are compiled into the binary — GitHub, Slack, Notion, Linear, Twenty CRM,
Zendesk, Salesforce, HubSpot, the Zoho family. Adding one is a config entry plus a credential.
Capabilities vary and I'd check before promising anything: GitHub exposes 606 write actions,
Twenty 112, HubSpot is read-only.

**What I'd need from you**

1. **Which systems hold Needletail's knowledge** — and read-only credentials for two or three
   of them. That turns a GitHub demo into your actual brain.
2. **A Slack workspace** to install the app into.
3. **A model provider key** for the agent.
4. **A decision on scope:** the prototype assumes one operator. Multiple people means
   per-user credential scoping — real work, and I'd rather size it with you than guess.

**What it isn't yet.** One connector is configured, pointed at a public repo. There are no
company documents in it — it's a GitHub brain today, not a company brain. It runs on my laptop.
And there's one seam I haven't proven: the agent proposing a write *from a Slack message* and
someone approving it in-channel. Every half of that works; I haven't watched them work
together. I'd rather tell you that than let you find it in a demo.

Happy to walk through it live, or to point it at something of yours and show you the same
thing answering a question that actually matters to you.

Best,
Karthik
