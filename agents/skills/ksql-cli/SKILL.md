---
name: ksql-cli
description: Provides Kingbase database querying via the ksql CLI, including schema inspection and SQL execution. Use when the user asks to query Kingbase, inspect schemas or tables, run SQL, or mentions ksql or Kingbase.
---

# ksql-cli

## Quick start

Use `ksql` to connect to Kingbase. Its syntax is basically compatible with `psql`.

Before running any database command, source `.env` from the current working directory, then build `DATABASE_PARAM` from these environment variables:

```sh
KB_USER
KB_PWD
KB_HOST
KB_PORT
KB_DBNAME
```

Connection parameter format:

```sh
user=$KB_USER password=$KB_PWD host=$KB_HOST port=$KB_PORT dbname=$KB_DBNAME
```

Preferred helper:

```sh
scripts/ksql-run.sh "\\d+t"
scripts/ksql-run.sh "\\d+ schema.table_name"
scripts/ksql-run.sh "SELECT * FROM schema.table_name LIMIT 10;"
```

Direct command form:

```sh
set -a
[ -f .env ] && . ./.env
set +a
DATABASE_PARAM="user=$KB_USER password=$KB_PWD host=$KB_HOST port=$KB_PORT dbname=$KB_DBNAME"
ksql "$DATABASE_PARAM" -P pager=off -Aq -c "\\d+t"
```

## Workflows

### Inspect all schemas or tables

```sh
scripts/ksql-run.sh "\\d+t"
```

### Inspect one table schema

```sh
scripts/ksql-run.sh "\\d+ <table>"
```

Use a schema-qualified table name when available:

```sh
scripts/ksql-run.sh "\\d+ public.my_table"
```

### Execute SQL

```sh
scripts/ksql-run.sh "SELECT * FROM <table> LIMIT 100;"
```

For exploratory `SELECT` queries, add `LIMIT 100` by default unless the user requests a different limit, the query is an aggregate/count query, or adding `LIMIT` would change the intended result.

For updates or destructive operations, confirm intent with the user unless they explicitly asked to execute the exact mutation.

```sh
scripts/ksql-run.sh "UPDATE <table> SET <column> = <value> WHERE <condition>;"
```

## Safety checklist

1. Always source `.env` from the current working directory before reading `KB_*` variables.
2. Never print `KB_PWD` or the full `DATABASE_PARAM` in the final answer.
3. Prefer read-only SQL unless the user explicitly requests mutation.
4. Add `LIMIT 100` to exploratory `SELECT` queries by default, unless the user requests a different limit or the query semantics make a limit inappropriate.
5. For `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`, `ALTER`, `CREATE`, or `INSERT`, mention the executed statement summary and affected output, but do not expose credentials.
5. If `ksql` is missing or connection fails, report the command category and error message without leaking password values.
