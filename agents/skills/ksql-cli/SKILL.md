---
name: ksql-cli
description: Provides Kingbase database querying via the ksql CLI, including schema inspection, SQL execution, and stored procedure/function invocation. Use when the user asks to query Kingbase, inspect schemas or tables, run SQL, call stored procedures or functions, or mentions ksql or Kingbase.
---

# ksql-cli

## Quick start

Use `scripts/ksql-run.sh` to query Kingbase databases. The script reads connection credentials from `.env` in the current working directory and handles the connection setup.

Two modes:
- `-c <sql>` — single SQL statement or ksql meta-command
- `-f <path>` — SQL file (for multi-line SQL, PL/pgSQL blocks, or complex statements)

```sh
scripts/ksql-run.sh -c "\\d+t"
scripts/ksql-run.sh -c "SELECT * FROM schema.table_name LIMIT 10;"
```

Required environment variables in `.env`:
- `KB_USER`
- `KB_PWD`
- `KB_HOST`
- `KB_PORT`
- `KB_DBNAME`

## Workflows

### Inspect all schemas or tables

```sh
scripts/ksql-run.sh -c "\\d+t"
```

### Inspect one table schema

```sh
scripts/ksql-run.sh -c "\\d+ <table>"
```

Use a schema-qualified table name when available:

```sh
scripts/ksql-run.sh -c "\\d+ public.my_table"
```

### Execute SQL

```sh
scripts/ksql-run.sh -c "SELECT * FROM <table> LIMIT 100;"
```

For exploratory `SELECT` queries, add `LIMIT 100` by default unless the user requests a different limit, the query is an aggregate/count query, or adding `LIMIT` would change the intended result.

For updates or destructive operations, confirm intent with the user unless they explicitly asked to execute the exact mutation.

```sh
scripts/ksql-run.sh -c "UPDATE <table> SET <column> = <value> WHERE <condition>;"
```

### Inspect stored procedures and functions

`\df` lists all stored procedures and functions; `\df+ <name>` shows the argument list, return type, and source body.

```sh
scripts/ksql-run.sh -c "\\df"
```

```sh
scripts/ksql-run.sh -c "\\df+ schema.name"
```

Use a schema-qualified name so `\df+` matches. If the full name is unknown, run `\df` first to find it.

The `Type` column in `\df` / `\df+` output tells procedure from function:

- `proc` — run with `CALL schema.name(...)` (no return value)
- `func` — run with `SELECT schema.name(...)` (returns a value)

### Execute stored procedures and functions

Two-step: inspect first, then execute.

1. Run `\df+ schema.name` to read the argument list, parameter direction (IN/OUT/INOUT), and types (and source body).
2. Build and execute the call from that signature.

**Functions (return a value)**

```sh
scripts/ksql-run.sh -c "SELECT schema.func_name(arg1, arg2);"
```

**Procedures (no return value)**

```sh
scripts/ksql-run.sh -c "CALL schema.proc_name(arg1, arg2);"
```

Literal conventions: strings use single quotes `'...'`, numbers are bare, `NULL` is written `NULL`.

**OUT / INOUT parameters**

- OUT parameters: when calling directly, leave OUT positions without an actual argument; Kingbase returns them as output columns.

```sh
scripts/ksql-run.sh -c "CALL schema.proc_name(in1, in2);"
```

- To capture OUT/INOUT values for further use, run a PL/pgSQL anonymous block that declares variables for the OUT/INOUT slots, calls the procedure, and reports the results. Write the block to a temp file and use `-f` mode:

```sh
sql_file=$(mktemp /tmp/ksql-XXXXXX.sql)
cat > "$sql_file" <<'EOF'
DO $$
DECLARE
  v_out1 result_type1;
  v_out2 result_type2;
BEGIN
  CALL schema.proc_name(in1, v_out1, v_out2);
  RAISE NOTICE 'v_out1=%', v_out1;
  RAISE NOTICE 'v_out2=%', v_out2;
END $$;
EOF
# If SQL contains mutations, prompt user: run `code <tempfile>` to review before executing
scripts/ksql-run.sh -f "$sql_file"
```

- INOUT parameters are both input and output. Pass the initial value and read back the rewritten value with the same file-based pattern:

```sh
sql_file=$(mktemp /tmp/ksql-XXXXXX.sql)
cat > "$sql_file" <<'EOF'
DO $$
DECLARE
  v_io inout_type;
BEGIN
  v_io := '<input>'::inout_type;
  CALL schema.proc_name(in1, v_io);
  RAISE NOTICE 'v_io=%', v_io;
END $$;
EOF
# If SQL contains mutations, prompt user: run `code <tempfile>` to review before executing
scripts/ksql-run.sh -f "$sql_file"
```

## When to use `-c` vs `-f`

Use `-c` for single-line SQL or ksql meta-commands.

Use `-f` (with a temp SQL file) when the SQL meets any of these criteria:
- Multi-line
- Contains `$$` (PL/pgSQL anonymous blocks)
- Contains nested semicolons that make shell quoting fragile

Always use `mktemp /tmp/ksql-XXXXXX.sql` to create the temp file. Files in `/tmp` are cleaned up by the OS, no manual cleanup needed.

## Safety checklist

1. Always source `.env` from the current working directory before reading `KB_*` variables.
2. Never print `KB_PWD` or the full `DATABASE_PARAM` in the final answer.
3. Prefer read-only SQL unless the user explicitly requests mutation.
4. Add `LIMIT 100` to exploratory `SELECT` queries by default, unless the user requests a different limit or the query semantics make a limit inappropriate.
5. For `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`, `ALTER`, `CREATE`, or `INSERT`, mention the executed statement summary and affected output, but do not expose credentials.
6. If `ksql` is missing or connection fails, report the command category and error message without leaking password values.
7. Before executing a stored procedure or function, run `\df+ schema.name` to confirm the signature (parameter types and IN/OUT/INOUT direction), then build the call statement.
8. Treat `CALL schema.name(...)` and `SELECT schema.name(...)` as potentially destructive by default; confirm intent with the user before executing, unless they explicitly say the procedure/function is read-only. For `-f` mode with mutations, prompt the user to run `code <tempfile>` to review before executing.
