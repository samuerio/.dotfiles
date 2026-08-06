---
name: duckdb
description: Provides DuckDB database querying via a wrapper script. Use when the user asks to query a DuckDB .db file, inspect tables, run SQL, or mentions duckdb.
---

# duckdb

## Overview

Use `{baseDir}/scripts/duckdb-run.sh` to query a DuckDB database file. The script reads `DUCKDB_FILE` from `.env` (auto-sourced) or environment.

Required environment variable in `.env`:
- `DUCKDB_FILE` — path to the `.db` file

## Workflows

### List all tables

```sh
{baseDir}/scripts/duckdb-run.sh ".tables"
```

### Inspect one table schema

```sh
{baseDir}/scripts/duckdb-run.sh ".schema my_table"
```

### Execute SQL

```sh
{baseDir}/scripts/duckdb-run.sh "SELECT * FROM my_table LIMIT 100"
```

For exploratory `SELECT` queries, add `LIMIT 100` by default unless the user requests a different limit, the query is an aggregate/count query, or adding `LIMIT` would change the intended result.

```sh
{baseDir}/scripts/duckdb-run.sh "UPDATE my_table SET status = 'active' WHERE id = 123"
```

For updates or destructive operations, confirm intent with the user unless they explicitly asked to execute the exact mutation.

### CSV output

When machine-readable output is needed, add `-csv` flag:

```sh
{baseDir}/scripts/duckdb-run.sh -csv "SELECT * FROM my_table LIMIT 100"
```

## Safety checklist

1. Prefer read-only SQL unless the user explicitly requests mutation.
2. Add `LIMIT 100` to exploratory `SELECT` queries by default, unless the user requests a different limit or the query semantics make a limit inappropriate.
3. For write operations (UPDATE, DELETE, INSERT, CREATE, DROP, ALTER, TRUNCATE), mention the executed statement summary and affected output.
4. If `duckdb` is missing or the database file is not found, report the error message clearly.
