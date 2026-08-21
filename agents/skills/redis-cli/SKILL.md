---
name: redis-cli
description: Provides Redis querying via the redis-cli CLI, including key inspection, command execution, and Lua scripting. Use when the user asks to query Redis, inspect keys, run Redis commands, or mentions redis-cli or Redis.
---

# redis-cli

## Quick start

Use `{baseDir}/scripts/redis-run.sh` to query Redis. The script reads connection credentials from `.env` in the current working directory and handles the connection setup.

Two modes:
- `-c <command>` — single Redis command (with its arguments)
- `-f <path>` — command file (one command per line), `MULTI/EXEC` transaction block, or Lua script

```sh
{baseDir}/scripts/redis-run.sh -c "GET foo"
{baseDir}/scripts/redis-run.sh -c "INFO server"
{baseDir}/scripts/redis-run.sh -f ./commands.txt
```

Environment variables in `.env` (only `REDIS_PWD` / `REDIS_USER` are required when the server enforces auth):

- `REDIS_HOST`（default `127.0.0.1`）
- `REDIS_PORT`（default `6379`）
- `REDIS_PWD`（optional; omit when no auth）
- `REDIS_DB`（optional, 0-15, default `0`）
- `REDIS_USER`（optional; ACL username for Redis 6+）

No TLS, no Cluster, no Sentinel.

## Workflows

### Explore keys (instead of `KEYS *`)

Never use `KEYS *` in production (it blocks the server). Use `SCAN`:

```sh
{baseDir}/scripts/redis-run.sh -c "SCAN 0 COUNT 100"
{baseDir}/scripts/redis-run.sh -c "SCAN 0 MATCH user:* COUNT 100"
```

`SCAN` returns a cursor and a batch of keys. Iterate by feeding the returned cursor back until it wraps to `0`.

After listing keys, inspect individual keys:

```sh
{baseDir}/scripts/redis-run.sh -c "TYPE mykey"
{baseDir}/scripts/redis-run.sh -c "TTL mykey"
{baseDir}/scripts/redis-run.sh -c "OBJECT ENCODING mykey"
{baseDir}/scripts/redis-run.sh -c "MEMORY USAGE mykey"
```

### Read key contents (by type)

Pick the read command for the key's type. For exploratory reads, add a range limit (`COUNT 100` / `LRANGE 0 99`) unless the user asks for the full value.

- string：`GET key`
- hash：`HGETALL key`（large hash：`HSCAN key 0 COUNT 100`）
- list：`LRANGE key 0 99`
- set：`SMEMBERS key`（large set：`SSCAN key 0 COUNT 100`）
- zset：`ZRANGE key 0 99 WITHSCORES`
- stream：`XRANGE key - + COUNT 100`

```sh
{baseDir}/scripts/redis-run.sh -c "HGETALL myhash"
{baseDir}/scripts/redis-run.sh -c "LRANGE mylist 0 99"
```

### Instance info

```sh
{baseDir}/scripts/redis-run.sh -c "INFO server"
{baseDir}/scripts/redis-run.sh -c "DBSIZE"
{baseDir}/scripts/redis-run.sh -c "CONFIG GET maxmemory"
```

### Write commands

```sh
{baseDir}/scripts/redis-run.sh -c "SET foo bar"
{baseDir}/scripts/redis-run.sh -c "HSET myhash f1 v1"
```

Destructive and overwrite commands follow the safety checklist below.

### Lua scripting (EVAL)

Simple one-line `EVAL` with `-c`:

```sh
{baseDir}/scripts/redis-run.sh -c "EVAL \"return redis.call('GET', KEYS[1])\" 1 foo"
```

Complex scripts use `-f` with a temp file, then prompt the user to review before executing:

```sh
script_file=$(mktemp /tmp/redis-XXXXXX.lua)
cat > "$script_file" <<'EOF'
local n = 0
for _, k in ipairs(KEYS) do
  redis.call('DEL', k)
  n = n + 1
end
return n
EOF
# review before executing
{baseDir}/scripts/redis-run.sh -f "$script_file"
```

For `MULTI/EXEC` transaction blocks, use `-f` with a command file:

```sh
cmd_file=$(mktemp /tmp/redis-XXXXXX.txt)
cat > "$cmd_file" <<'EOF'
MULTI
SET counter 0
INCR counter
INCR counter
EXEC
EOF
{baseDir}/scripts/redis-run.sh -f "$cmd_file"
```

## When to use `-c` vs `-f`

Use `-c` for a single Redis command or a single-line `EVAL`.

Use `-f` when the input meets any of these criteria:
- One command per line across multiple lines (batch)
- `MULTI` / `EXEC` transaction block
- Multi-line Lua `EVAL` script

Always use `mktemp /tmp/redis-XXXXXX.lua` (for Lua) or `mktemp /tmp/redis-XXXXXX.txt` (for command batches) to create the temp file. Files in `/tmp` are cleaned up by the OS, no manual cleanup needed.

## Safety checklist

1. Irreversible commands (`FLUSHDB` / `FLUSHALL` / `SHUTDOWN` / `CONFIG SET` / `DEBUG *` / `BGREWRITEAOF` / `BGSAVE`) require explicit user confirmation before executing.
2. Key-deleting or key-overwriting commands (`DEL` / `UNLINK` / `RENAME` / `GETSET` / `EXPIRE` / `PEXPIRE` / `EXPIREAT` / `EVAL`) are confirmed by default. If the user already explicitly requested the exact operation this turn, do not ask again, but report the impact.
3. Overwrite-style writes (`SET` / `MSET` / `HSET` / `LPUSH` / `RPUSH` / `SADD` / `ZADD` / `XADD` etc.) execute directly; mention in the result whether an existing value was overwritten. `SETNX` is idempotent and needs no note. `PERSIST` executes directly and is noted in the result.
4. Read-only commands (`GET` / `HGETALL` / `LRANGE` / `SMEMBERS` / `ZRANGE` / `TYPE` / `TTL` / `OBJECT` / `SCAN` / `INFO` / `CONFIG GET` / `DBSIZE` / `MEMORY USAGE`) execute directly.
5. For exploratory reads, add a range limit (`COUNT 100` / `LRANGE 0 99`) by default, unless the user requests the full value or the query semantics make a limit inappropriate.
6. Never use `KEYS *`; use `SCAN` instead.
7. Never print `REDIS_PWD` in the final answer.
8. Complex Lua scripts use `-f` with a `mktemp` heredoc; prompt `code <tempfile>` for review before executing. Treat `EVAL` as destructive by default (the script body may contain `DEL` / `FLUSH*` etc.).
