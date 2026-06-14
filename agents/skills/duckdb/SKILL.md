---
name: duckdb
description: Provides DuckDB querying via the duckdb CLI, including schema inspection, SQL execution, and direct querying of CSV/Parquet/JSON files. Use when the user asks to query DuckDB, inspect tables, run SQL, analyze local data files, or mentions duckdb.
---

# duckdb

## Quick start

Use `duckdb` to query a local database file or run in-memory analytics. Its meta-command syntax is SQLite-compatible.

Before running any command, source `.env` from the current working directory if it exists. The environment variable `DUCKDB_FILE` specifies a default database file.

Preferred helper:

```sh
# In-memory (no database file)
scripts/duckdb-run.sh "SELECT 42"

# With database file (CLI arg)
scripts/duckdb-run.sh /path/to/data.db ".tables"

# With database file (from DUCKDB_FILE env var)
scripts/duckdb-run.sh "SELECT * FROM my_table LIMIT 10"
```

## Workflows

### List all tables

```sh
scripts/duckdb-run.sh [db] ".tables"
```

### Inspect one table schema

```sh
scripts/duckdb-run.sh [db] ".schema my_table"
```

### Execute SQL

```sh
scripts/duckdb-run.sh [db] "SELECT * FROM my_table LIMIT 100"
```

For exploratory `SELECT` queries, add `LIMIT 100` by default unless the user requests a different limit, the query is an aggregate/count query, or adding `LIMIT` would change the intended result.

For updates or destructive operations, confirm intent with the user unless they explicitly asked to execute the exact mutation.

### Query external files

DuckDB can query CSV, Parquet, and JSON files directly without importing:

```sh
# CSV
scripts/duckdb-run.sh "SELECT * FROM 'data.csv' LIMIT 100"

# Parquet
scripts/duckdb-run.sh "SELECT * FROM 'data.parquet' LIMIT 100"

# JSON
scripts/duckdb-run.sh "SELECT * FROM 'data.json' LIMIT 100"

# Glob pattern for multiple files
scripts/duckdb-run.sh "SELECT * FROM 'data/*.parquet' LIMIT 100"
```

Use in-memory mode (no db file argument) when querying external files, unless the user wants to persist results into a database.

### CSV output

When machine-readable output is needed, add `-csv` flag:

```sh
scripts/duckdb-run.sh -csv "SELECT * FROM 'data.csv' LIMIT 100"
```

## Safety checklist

1. Always source `.env` from the current working directory before reading `DUCKDB_FILE`.
2. Prefer read-only SQL unless the user explicitly requests mutation.
3. Add `LIMIT 100` to exploratory `SELECT` queries by default, unless the user requests a different limit or the query semantics make a limit inappropriate.
4. For `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`, `ALTER`, `CREATE`, or `INSERT`, mention the executed statement summary and affected output.
5. When querying external files, verify the file path exists before running the query.
6. If `duckdb` is missing or the database file is not found, report the error message clearly.
