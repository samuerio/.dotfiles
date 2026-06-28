---
name: tmux
description: "Remote control tmux sessions for interactive CLIs (python, gdb, etc.) by sending keystrokes and scraping pane output."
license: Vibecoded
---

# tmux Skill

Use tmux as a programmable terminal multiplexer for interactive work. Works on Linux and macOS with stock tmux; use user's tmux config with a private socket for isolation.

## Quickstart (isolated socket)

### Variables Used in This Document

| Placeholder | Meaning | Notes |
|---|---|---|
| `<socket>` | Private tmux socket file path | Default: `/tmp/claude-tmux-sockets/claude.sock`. Keeps agent sessions separate from your personal tmux. Change only when you need to isolate further. |
| `<session>` | tmux session name | Slug-like, no spaces, e.g. `claude-python`. |
| `<target>` | Pane target | Format: `<session>:window.pane`, e.g. `<session>:0.0`. |

```bash
mkdir -p /tmp/claude-tmux-sockets
tmux -S <socket> new -d -s <session> -n shell
tmux -S <socket> send-keys -t <target> -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter
tmux -S <socket> capture-pane -p -J -t <target> -S -200
tmux -S <socket> kill-session -t <session>
```

After starting a session ALWAYS tell the user how to monitor the session by giving them a command to copy paste:

```
To monitor this session yourself:
  tmux -S <socket> attach -t <session>

Or to capture the output once:
  tmux -S <socket> capture-pane -p -J -t <target> -S -200
```

This must ALWAYS be printed right after a session was started and once again at the end of the tool loop.  But the earlier you send it, the happier the user will be.

## Socket convention

- Place tmux sockets under `/tmp/claude-tmux-sockets/` and use `tmux -S <socket>`. Create the dir first: `mkdir -p /tmp/claude-tmux-sockets`.
- Default socket file: `/tmp/claude-tmux-sockets/claude.sock`. Change only when you need to isolate further.

## Targeting panes and naming

- Target format: `{session}:{window}.{pane}`, defaults to `:0.0` if omitted. Keep names short (e.g., `claude-py`, `claude-gdb`).
- Use `-S <socket>` consistently to stay on the private socket path. By default uses user's tmux config; use `-f /dev/null` for a clean config if needed.
- If you use your tmux config (no `-f /dev/null`), do not assume `:0.0`; discover pane ids via `tmux -S <socket> list-panes -t <session> -F '#{session_name}:#{window_index}.#{pane_index}'`.
- Inspect: `tmux -S <socket> list-sessions`, `tmux -S <socket> list-panes -a`.

## Finding sessions

- List sessions on your active socket with metadata: `bash scripts/find-sessions.sh -S <socket>`; add `-q partial-name` to filter.
- For machine parsing, emit JSON: `bash scripts/find-sessions.sh -S <socket> --json`.
- Scan all sockets under the shared directory: `bash scripts/find-sessions.sh --all` (scans `/tmp/claude-tmux-sockets`).

## Checking pane readiness

Before sending any command to a pane, verify the pane is at an idle shell prompt and not running a process:

```bash
tmux -S <socket> capture-pane -p -J -t <target> -S -10
```

Inspect the last 10 lines. The pane is **ready** if the last non-empty line matches a shell prompt pattern (`\$\s*$`, `#\s*$`, or `%\s*$`). If it does not match — e.g. a process is still running, or a program like `pi` is active — **do not send input**. Report to the user that the pane is busy and wait for explicit confirmation before proceeding.

## Sending input safely

- Prefer literal sends to avoid shell splitting: `tmux -S <socket> send-keys -t target -l -- "$cmd"`
- When composing inline commands, use single quotes or ANSI C quoting to avoid expansion: `tmux ... send-keys -t target -- $'python3 -m http.server 8000'`.
- To send control keys: `tmux ... send-keys -t target C-c`, `C-d`, `C-z`, `Escape`, etc.

## Watching output

- Capture recent history (joined lines to avoid wrapping artifacts): `tmux -S <socket> capture-pane -p -J -t target -S -200`.
- For continuous monitoring or waiting for a prompt/completion marker, poll with the helper script (below) instead of `tmux wait-for` (which does not watch pane output). Example: wait for a Python prompt before sending code:
  ```bash
  bash scripts/wait-for-text.sh -S <socket> -t <session>:0.0 -p '^>>>' -T 15 -l 4000
  ```
- For long-running commands, poll for completion text (`"Type quit to exit"`, `"Program exited"`, etc.) before proceeding.
- When giving instructions to a user, **explicitly print a copy/paste monitor command** alongside the action — don't assume they remembered the command.

## Spawning Processes

Some special rules for processes:

- when asked to debug, use lldb by default
- when starting a python interactive shell, always set the `PYTHON_BASIC_REPL=1` environment variable. This is very important as the non-basic console interferes with your send-keys.

## Interactive tool recipes

- **Python REPL**: `tmux ... send-keys -- 'python3 -q' Enter`; wait for `^>>>`; send code with `-l`; interrupt with `C-c`. Always with `PYTHON_BASIC_REPL`.
- **gdb**: `tmux ... send-keys -- 'gdb --quiet ./a.out' Enter`; disable paging `tmux ... send-keys -- 'set pagination off' Enter`; break with `C-c`; issue `bt`, `info locals`, etc.; exit via `quit` then confirm `y`.
- **Other TTY apps** (ipdb, psql, mysql, node, bash): same pattern—start the program, poll for its prompt, then send literal text and Enter.

## Cleanup

- Kill a session when done: `tmux -S <socket> kill-session -t <session>`.
- Kill all sessions on a socket: `tmux -S <socket> list-sessions -F '#{session_name}' | xargs -r -n1 tmux -S <socket> kill-session -t`.
- Remove everything on the private socket: `tmux -S <socket> kill-server`.

## Helper: wait-for-text.sh

`scripts/wait-for-text.sh` polls a pane for a regex (or fixed string) with a timeout. Works on Linux/macOS with bash + tmux + grep.

```bash
bash scripts/wait-for-text.sh -S <socket> -t session:0.0 -p 'pattern' [-F] [-T 20] [-i 0.5] [-l 2000]
```

- `-t`/`--target` pane target (required)
- `-p`/`--pattern` regex to match (required); add `-F` for fixed string
- `-S`/`--socket-path` socket path (recommended with private sockets), or `-L`/`--socket` socket name
- `-T` timeout seconds (integer, default 15)
- `-i` poll interval seconds (default 0.5)
- `-l` history lines to search from the pane (integer, default 1000)
- Exits 0 on first match, 1 on timeout. On failure prints the last captured text to stderr to aid debugging.
