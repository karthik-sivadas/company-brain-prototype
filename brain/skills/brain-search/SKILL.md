---
name: brain-search
description: How to search the Company Brain. Use this for ANY question about company data, GitHub issues, synced records, documents or SOPs. Explains where the data lives and how to query it with DuckDB.
---

# brain-search

The Company Brain's data is extracted by the `pm` CLI into a local warehouse and stored as **Parquet** tables.

## Where the data lives

- Warehouse root: `data/pm/.polymetrics/warehouse/`
- Tables are Parquet files under `ws_*/<connector>/<connection>/tables/*.parquet`
- Find them with: `find data/pm/.polymetrics/warehouse -name '*.parquet' -not -name 'transport-*'`
- Seed documents and SOPs: `brain/docs/**/*.md`
- Human-captured answers: `brain/memory/facts/*.md`

## How to query

Use the `duckdb` CLI. It reads Parquet directly — no import needed.

```bash
duckdb -c "SELECT number, title, state, created_at FROM read_parquet('<path>') ORDER BY created_at DESC LIMIT 10;"
duckdb -c "DESCRIBE SELECT * FROM read_parquet('<path>');"   # discover columns first
```

Currently synced: **GitHub issues** from `polymetrics-ai/cli` at
`/Users/karthiksivadas/Development/company-brain-prototype/data/pm/.polymetrics/warehouse/ws_01f1f8ae9139d228/github/conn_206bd2e06f84fac6/tables/gh_issues.parquet`
Columns include: number, title, body, state, html_url, user_id, labels, comments, created_at, updated_at, closed_at.

## Rules

1. **Always look at the real data before answering.** Run `DESCRIBE` first if unsure of columns.
2. **Cite your source**: give the table path or document path, and for issues include the `html_url`.
3. For prose questions, search `brain/docs/` and `brain/memory/` with grep before answering.
4. **If the data does not contain the answer, say so** and suggest asking a human — do not guess.
