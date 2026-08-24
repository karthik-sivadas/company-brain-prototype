# Company Brain — prototype

`pm` extracts. **OMP** is the agent. Skills and docs are files in `brain/`.
No database server, no custom agent runtime, no vector index.

## Layout
```
bin/pm                built from polymetrics-ai/cli @ main
data/pm/.polymetrics/ pm project — warehouse (Parquet), state, vault
brain/skills/         how-to skills (pm-* generated + brain-search + domain)
brain/docs/           SOPs and policies (Markdown)
brain/memory/facts/   answers captured from humans
scripts/sync.sh       run the extractions
scripts/ask.sh        ask a question
.omp/skills -> brain/skills   so OMP discovers them
```

## Use
```bash
./scripts/sync.sh                       # extract
./scripts/ask.sh "how many issues are synced, and the 3 newest?"
```

## Verified working
- pm built from latest `main` (`72fe0ba8`) — **557 executable connectors**
- GitHub ETL: 46 issues → Parquet, typed columns, queryable by DuckDB
- OMP discovers `brain/skills`, queries the warehouse and answers with citations
