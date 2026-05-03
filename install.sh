#!/usr/bin/env bash
set -euo pipefail

# Dotfiles installation script
# Usage: ./install.sh

DOTFILES_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() {
    printf "\033[34m[INFO]\033[0m %s\n" "$1"
}

warn() {
    printf "\033[33m[WARN]\033[0m %s\n" "$1"
}

err() {
    printf "\033[31m[ERR]\033[0m  %s\n" "$1"
}

# Ensure parent directory exists
ensure_dir() {
    local target="$1"
    local parent
    parent="$(dirname "$target")"
    if [[ ! -d "$parent" ]]; then
        mkdir -p "$parent"
        info "Created directory: $parent"
    fi
}

# Create a symbolic link from source (relative to DOTFILES_ROOT) to target
# Rules:
#   - If target does not exist: create symlink
#   - If target is a broken symlink: remove and recreate
#   - Otherwise (file, dir, or valid symlink): skip
link_dotfile() {
    local src_rel="$1"
    local target="$2"
    local src
    src="${DOTFILES_ROOT}/${src_rel}"

    if [[ ! -e "$src" && ! -L "$src" ]]; then
        err "Source does not exist: $src"
        return 1
    fi

    ensure_dir "$target"

    if [[ -L "$target" && ! -e "$target" ]]; then
        # Broken symlink: force overwrite
        warn "Removing broken symlink: $target"
        rm "$target"
    elif [[ -e "$target" || -L "$target" ]]; then
        # Valid file, directory, or symlink: skip
        warn "Already exists (skipping): $target"
        return 0
    fi

    ln -s "$src" "$target"
    info "Linked: $target -> $src"
}

install_tmux() {
    info "Installing tmux configuration..."

    link_dotfile ".tmux.conf" "${HOME}/.tmux.conf"
    link_dotfile ".tmux.conf.local" "${HOME}/.tmux.conf.local"
    link_dotfile "tmux" "${HOME}/.config/tmux"

    info "Tmux configuration installed."
}

install_nvim() {
    info "Installing Neovim configuration..."

    link_dotfile "nvim" "${HOME}/.config/nvim"

    info "Neovim configuration installed."
}

install_ai_agents() {
    info "Installing AI agent configurations..."

    link_dotfile "pi" "${HOME}/.pi"
    link_dotfile "opencode" "${HOME}/.config/opencode"
    link_dotfile "agents" "${HOME}/.agents"

    info "AI agent configurations installed."
}

main() {
    install_tmux
    install_nvim
    install_ai_agents
}

main "$@"
