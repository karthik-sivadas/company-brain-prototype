**To:** jofin@needletailai.com
**Subject:** Company Brain — working prototype + how I'd build it

Hi Jofin,

Thanks again for the problem. Here's where I landed, and the repo:
https://github.com/karthik-sivadas/company-brain-prototype

**The thing I decided first**

Most of a "Company Brain" is a solved problem wearing a new name. The genuinely hard part isn't
retrieval or chat — it's *sync*: knowing what changed since last time, deduplicating, propagating
deletions, and keeping a run ledger so the corpus is still true next week. Everything else is
plumbing on top of that.

So I didn't build a platform. I composed one:

- **`pm`** (a local-first ETL CLI) does extraction — 557 built-in connectors, incremental
  cursors, primary-key dedup, tombstones, a run ledger, and approval-gated writes.
- **`omp`** (an agent runtime) does the reasoning — it already has the tool loop, sessions and
  skill discovery, so I wrote none of that.
- **DuckDB** queries pm's Parquet warehouse in place. No import step, no vector database.
- **The knowledge itself is a folder** of Markdown — skills, SOPs, and answers captured from
  people. Anyone on your team can edit it without touching code.

No bespoke agent runtime, no embedding index, no application server. That is the whole design.

**What actually works today**

- `pm` built from source; GitHub connector syncing real issues into a Parquet warehouse
- The agent answers from that warehouse *and* from local SOPs, citing its source every time —
  a table path, or a file with line numbers, or the issue's URL
- One command bootstraps it: `bun run brain setup`, then `bun run brain ask "..."`
- Asked to add Slack as a source, the agent read the project's own setup skill, inspected the
  installed connector's real schema, and corrected an error in my instructions before answering

**What I deliberately left out**

Embeddings, a vector store, permissions sync, and a chat UI. At this corpus size agentic search
(grep + SQL) is genuinely sufficient, and each of those is a real improvement *later* rather than
a prerequisite for showing the idea works. I'd rather show you a small thing that runs than a
large thing that doesn't.

**Where I'd take it next, in order**

1. **The loop that matters for you specifically** — when the brain doesn't know something, it asks
   a named person, and their answer becomes a citable, owned document. Your ops model is already
   human-in-the-loop; the brain should work the same way. That's the piece that gets knowledge out
   of people's heads instead of just indexing what's already written down.
2. **Slack as the surface**, since that's where the questions actually get asked — and as a source.
3. Permissions from the source systems, then embeddings once the corpus outgrows grep.

Happy to walk through it live, or to point it at a real source of yours and show it answering
from your own data.

Best,
Karthik
