---
name: gccli
description: Provides GBase 8a database querying via the gccli CLI, including schema inspection, SQL execution, and stored procedure/function invocation. Use when the user asks to query GBase, inspect schemas or tables, run SQL, call stored procedures or functions, or mentions gccli or GBase.
---

# gccli

## Quick start

Use `{baseDir}/scripts/gccli-run.sh` to query GBase 8a databases. The script reads connection credentials from `.env` in the current working directory and handles the connection setup.

Two modes:
- `-e <sql>` — single SQL statement or multiple statements separated by `;`
- `-f <path>` — SQL file (for multi-line SQL, user variables, or complex statements)

```sh
{baseDir}/scripts/gccli-run.sh -e "SELECT DATABASE();"
{baseDir}/scripts/gccli-run.sh -e "SELECT * FROM my_table LIMIT 10;"
```

Required environment variables in `.env`:
- `GBASE_HOST` (supports comma-separated IPs for high availability)
- `GBASE_USER`
- `GBASE_PWD`
- `GBASE_DB`

Optional:
- `GBASE_PORT` (default: 5258)

## Workflows

### Check current database context

`GBASE_DB` is required in `.env`, so the connection already targets a specific database. Before starting operations, confirm the current database:

```sh
{baseDir}/scripts/gccli-run.sh -e "SELECT DATABASE();"
```

Remember the returned database name for use in subsequent `SHOW PROCEDURE/FUNCTION STATUS WHERE Db='...'` filters.

### Inspect tables

```sh
{baseDir}/scripts/gccli-run.sh -e "SHOW TABLE STATUS;"
{baseDir}/scripts/gccli-run.sh -e "SHOW TABLE STATUS LIKE '%pattern%';"
```

Use `SHOW TABLE STATUS` by default because it returns the `Comment` column (table annotations), which helps understand table purposes. Output includes 25+ columns (Name, Engine, Rows, storage_size, Comment, etc.), sourced from information_schema.tables.

For single-table detailed status, use vertical output (`\G`):
```sh
{baseDir}/scripts/gccli-run.sh -e "SHOW TABLE STATUS WHERE name='mytable'\G"
```

### Inspect table schema

Use `SHOW FULL COLUMNS` to view column information, including the `Comment` column (field annotations), as well as Collation, Privileges, etc.:

```sh
{baseDir}/scripts/gccli-run.sh -e "SHOW FULL COLUMNS FROM mytable;"
```

To view the CREATE TABLE statement (including distribution key, engine, table comment):
```sh
{baseDir}/scripts/gccli-run.sh -e "SHOW CREATE TABLE mytable;"
```

### Execute SQL

```sh
{baseDir}/scripts/gccli-run.sh -e "SELECT * FROM mytable LIMIT 100;"
```

For exploratory `SELECT` queries, add `LIMIT 100` by default unless the user requests a different limit, the query is an aggregate/count query, or adding `LIMIT` would change the intended result.

For updates or destructive operations, confirm intent with the user unless they explicitly asked to execute the exact mutation.

### Inspect stored procedures and functions

Filter by database by default to avoid returning procedures/functions from all databases (which can be very large):

```sh
{baseDir}/scripts/gccli-run.sh -e "SHOW PROCEDURE STATUS WHERE Db='mydb';"
{baseDir}/scripts/gccli-run.sh -e "SHOW FUNCTION STATUS WHERE Db='mydb';"
```

Supports fuzzy matching:
```sh
{baseDir}/scripts/gccli-run.sh -e "SHOW PROCEDURE STATUS WHERE Db='mydb' AND Name LIKE '%pattern%';"
```

To view the full definition (parameters, direction, SQL body), use `\G` for vertical output:
```sh
{baseDir}/scripts/gccli-run.sh -e "SHOW CREATE PROCEDURE mydb.myproc\G"
{baseDir}/scripts/gccli-run.sh -e "SHOW CREATE FUNCTION mydb.myfunc\G"
```

Use schema-qualified names. If the full name is unknown, run `SHOW PROCEDURE/FUNCTION STATUS WHERE Db='mydb'` first to find it.

`SHOW CREATE` returns the complete CREATE PROCEDURE/FUNCTION statement. Parse from it:
- Parameter names, types, and direction (IN/OUT/INOUT)
- Function return type (FUNCTION only)
- Procedure/function body (BEGIN...END block)

### Execute stored procedures and functions

**Two-step process**: inspect first, then execute.

1. Run `SHOW CREATE PROCEDURE/FUNCTION name\G` to read parameter list, direction (IN/OUT/INOUT), and types
2. Build and execute the call from that signature

**Functions (return a value)**

```sh
{baseDir}/scripts/gccli-run.sh -e "SELECT mydb.myfunc(arg1, arg2);"
```

Or capture to a variable:
```sh
{baseDir}/scripts/gccli-run.sh -e "SET @result = mydb.myfunc(arg1, arg2); SELECT @result;"
```

**Procedures (no return value, or only IN parameters)**

```sh
{baseDir}/scripts/gccli-run.sh -e "CALL mydb.myproc(arg1, arg2);"
```

Literal conventions: strings use single quotes `'...'`, numbers are bare, `NULL` is written `NULL`.

**OUT / INOUT parameters**

GBase 8a supports user variables `@var` to capture OUT/INOUT parameter values. Write to a temp file and use `-f` mode:

```sh
sql_file=$(mktemp /tmp/gccli-XXXXXX.sql)
cat > "$sql_file" <<'EOF'
CALL mydb.myproc(in1, @out1, @out2);
SELECT @out1, @out2;
EOF
# If SQL contains mutations, prompt user: run `code <tempfile>` to review before executing
{baseDir}/scripts/gccli-run.sh -f "$sql_file"
```

INOUT parameters pass initial value and read back the rewritten value:

```sh
sql_file=$(mktemp /tmp/gccli-XXXXXX.sql)
cat > "$sql_file" <<'EOF'
SET @io = 'initial_value';
CALL mydb.myproc(in1, @io);
SELECT @io;
EOF
# If SQL contains mutations, prompt user: run `code <tempfile>` to review before executing
{baseDir}/scripts/gccli-run.sh -f "$sql_file"
```

## When to use `-e` vs `-f`

Use `-e` for:
- Single-line SQL
- Multiple statements separated by `;` (no DELIMITER needed)

Use `-f` (with a temp SQL file) when the SQL meets any of these criteria:
- Multi-line
- Contains DELIMITER commands (for creating stored procedures)
- Contains user variable assignments combined with other statements
- Shell quoting becomes fragile

Always use `mktemp /tmp/gccli-XXXXXX.sql` to create the temp file. Files in `/tmp` are cleaned up by the OS, no manual cleanup needed.

## Safety checklist

1. Never print `GBASE_PWD` or the full connection parameters in the final answer.
2. Prefer read-only SQL unless the user explicitly requests mutation.
3. Add `LIMIT 100` to exploratory `SELECT` queries by default, unless the user requests a different limit or the query semantics make a limit inappropriate.
4. For `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`, `ALTER`, `CREATE`, or `INSERT`, mention the executed statement summary and affected output, but do not expose credentials.
5. If `gccli` is missing or connection fails, report the command category and error message without leaking password values.
6. Before executing a stored procedure or function, run `SHOW CREATE PROCEDURE/FUNCTION name\G` to confirm the signature (parameter types and IN/OUT/INOUT direction), then build the call statement.
7. Treat `CALL proc(...)` and `SELECT func(...)` as potentially destructive by default; confirm intent with the user before executing, unless they explicitly say the procedure/function is read-only. For `-f` mode with mutations, prompt the user to run `code <tempfile>` to review before executing.

## GBase 8a specific notes

- No PL/pgSQL anonymous blocks, but supports user variables `@var`.
