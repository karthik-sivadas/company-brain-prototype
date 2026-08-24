---
name: brain-search
description: How to search the Company Brain. Use for ANY question about company data, synced records, issues, documents or SOPs. Explains where the data lives and how to query it with DuckDB.
---

# brain-search

Company knowledge is extracted by `pm` into a local warehouse of **Parquet** tables.
Answer from that warehouse. There is no git checkout here and no network access —
a question about "GitHub issues" means the synced `gh_issues` table, not a repository
on disk and not the GitHub API.

## Resolve the roots first

This skill is read both on the host and inside the sandbox, where the same data is
mounted at a different prefix. Resolve the roots instead of assuming either:

```bash
WAREHOUSE=$([ -d /warehouse ] && echo /warehouse || echo data/pm/.polymetrics/warehouse)
BRAIN=$([ -d /brain ] && echo /brain || echo brain)
```

## Tables available (paths relative to $WAREHOUSE)
- `ws_01f1f8ae9139d228/github/conn_206bd2e06f84fac6/tables/gh_issues.parquet`
- `ws_01f1f8ae9139d228/github/conn_3fa7dea874c16bbd/tables/github_releases.parquet`
- `ws_01f1f8ae9139d228/github/conn_bb163921b9d1b197/tables/github_pull_requests.parquet`

Discover any table:

```bash
find "$WAREHOUSE" -name '*.parquet' -not -name 'transport-*'
```

## How to query

```bash
duckdb -c "DESCRIBE SELECT * FROM read_parquet('$WAREHOUSE/<relative-path>');"
duckdb -c "SELECT count(*) FROM read_parquet('$WAREHOUSE/<relative-path>');"
```

## Rules
1. **Look at the real data before answering.** Never guess a column name — `DESCRIBE` first.
2. **Cite the source**: the table path, plus `html_url` where rows have one.
3. Prose questions: `grep -r "$BRAIN/docs" "$BRAIN/memory"`.
4. **If the answer is not in the data, say so** and suggest asking a person. Do not invent it.
5. **Never report the workspace as empty without running the `find` above.**
