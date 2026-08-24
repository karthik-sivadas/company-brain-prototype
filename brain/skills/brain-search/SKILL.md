---
name: brain-search
description: How to search the Company Brain. Use for ANY question about company data, synced records, documents or SOPs. Explains where the data lives and how to query it with DuckDB.
---

# brain-search

Data is extracted by `pm` into a local warehouse of **Parquet** tables.

## Where things live
- Warehouse tables (query these):
- `/Users/karthiksivadas/Development/company-brain-prototype/data/pm/.polymetrics/warehouse/ws_01f1f8ae9139d228/github/conn_206bd2e06f84fac6/tables/gh_issues.parquet`
- Find any table: `find data/pm/.polymetrics/warehouse -name '*.parquet' -not -name 'transport-*'`
- Documents and SOPs: `brain/docs/**/*.md`
- Answers captured from people: `brain/memory/facts/*.md`

## How to query
```bash
duckdb -c "DESCRIBE SELECT * FROM read_parquet('<path>');"          # discover columns first
duckdb -c "SELECT * FROM read_parquet('<path>') LIMIT 5;"
```

## Rules
1. **Look at the real data before answering.** Never guess a column name — `DESCRIBE` first.
2. **Cite the source**: the table path or the document path, plus `html_url` where rows have one.
3. Search `brain/docs/` and `brain/memory/` with grep for prose questions.
4. **If the answer is not in the data, say so** and suggest asking a person. Do not invent it.
