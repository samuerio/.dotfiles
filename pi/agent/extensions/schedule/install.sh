#!/usr/bin/env bash
# Put the `schedule` CLI on PATH.
#
# The scheduler needs exactly one thing outside this directory: a `schedule`
# executable in a directory that a human shell and cron both search.
# /usr/local/bin is that directory. Writing there needs root, so this is a
# deliberate per-machine install step (the top-level install.sh calls it, and
# passes the command through to you when it cannot create the link itself)
# rather than something a pi session does at runtime.
#
#   ./install.sh              link /usr/local/bin/schedule -> cli.ts
#   ./install.sh --uninstall  remove that link
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SCRIPT_DIR}/cli.ts"
TARGET="/usr/local/bin/schedule"

info() {
    printf "\033[34m[INFO]\033[0m %s\n" "$1"
}

warn() {
    printf "\033[33m[WARN]\033[0m %s\n" "$1"
}

die() {
    printf "\033[31m[ERR]\033[0m  %s\n" "$1" >&2
    exit 1
}

usage() {
    cat <<'EOF'
usage: install.sh [--uninstall]

  (no argument)  link /usr/local/bin/schedule to this directory's cli.ts
  --uninstall    remove that link, leaving tasks and run history untouched
EOF
}

# Our link is created with an absolute target, so comparing readlink's raw
# output identifies it without `readlink -f` (BSD readlink lacks the flag).
is_our_link() {
    [[ -L "$TARGET" ]] && [[ "$(readlink "$TARGET")" == "$SOURCE" ]]
}

# Create or replace the link; fall back to a no-prompt sudo, then to the
# command the user has to run. A password prompt would hang an unattended
# install.sh, so there is no interactive sudo here.
make_link() {
    if ln -sfn "$SOURCE" "$TARGET" 2>/dev/null; then
        return 0
    fi
    if command -v sudo >/dev/null 2>&1 && sudo -n ln -sfn "$SOURCE" "$TARGET" 2>/dev/null; then
        return 0
    fi
    warn "$TARGET is not writable. Create the link yourself:"
    printf '  sudo ln -sfn "%s" "%s"\n' "$SOURCE" "$TARGET"
    return 1
}

remove_link() {
    if rm -f "$TARGET" 2>/dev/null; then
        return 0
    fi
    if command -v sudo >/dev/null 2>&1 && sudo -n rm -f "$TARGET" 2>/dev/null; then
        return 0
    fi
    warn "$TARGET is not writable. Remove the link yourself:"
    printf '  sudo rm -f "%s"\n' "$TARGET"
    return 1
}

case "${1:-}" in
    "") ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        die "unknown argument: $1"
        ;;
esac

if [[ "${UNINSTALL:-0}" -eq 1 ]]; then
    if ! is_our_link; then
        warn "$TARGET is not a link to $SOURCE; nothing to do"
        exit 0
    fi
    remove_link || exit 1
    info "removed $TARGET"
    exit 0
fi

[[ -f "$SOURCE" ]] || die "missing $SOURCE"
[[ -x "$SOURCE" ]] || die "$SOURCE is not executable (chmod +x it in the repo)"

# The CLI is a TypeScript file run by node's type stripping, so node must be
# resolvable through the same PATH that will run the link.
command -v node >/dev/null 2>&1 || warn "node is not on PATH; $TARGET will not run"

if is_our_link; then
    info "already linked: $TARGET -> $SOURCE"
else
    [[ -e "$TARGET" && ! -L "$TARGET" ]] &&
        die "$TARGET exists and is not a symlink; refusing to overwrite it"
    make_link || exit 1
    info "linked: $TARGET -> $SOURCE"
fi

# Same entry point a human and the crontab use, so a failure here is a failure
# worth reporting now rather than at the first missed slot.
if ! smoke="$("$TARGET" list --json 2>&1)"; then
    die "$TARGET list failed:
$smoke"
fi
info "smoke test passed: $TARGET list --json"

info "next: arm the scheduler with 'schedule install-cron' (it rewrites your crontab)"
