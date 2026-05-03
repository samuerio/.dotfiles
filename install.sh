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

section() {
    printf "\n\033[1m=== %s ===\033[0m\n" "$1"
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
    section "tmux"
    link_dotfile ".tmux.conf" "${HOME}/.tmux.conf"
    link_dotfile ".tmux.conf.local" "${HOME}/.tmux.conf.local"
    link_dotfile "tmux" "${HOME}/.config/tmux"
}

install_nvim() {
    section "nvim"
    link_dotfile "nvim" "${HOME}/.config/nvim"
}

install_ai_agents() {
    section "ai-agents"
    link_dotfile "pi" "${HOME}/.pi"
    link_dotfile "opencode" "${HOME}/.config/opencode"
    link_dotfile "agents" "${HOME}/.agents"
    link_dotfile ".aider.conf.yml" "${HOME}/.aider.conf.yml"
}

install_lazygit() {
    section "lazygit"
    link_dotfile "lazygit" "${HOME}/.config/lazygit"
}

install_ranger() {
    section "ranger"
    link_dotfile "ranger" "${HOME}/.config/ranger"
}

install_zsh() {
    section "zsh"
    link_dotfile "zsh/.zshrc" "${HOME}/.zshrc"
    link_dotfile "zsh/.p10k.zsh" "${HOME}/.p10k.zsh"
}

install_git() {
    section "git"
    link_dotfile "git/.gitconfig" "${HOME}/.gitconfig"
}

install_x11() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "x11"
        warn "Skipping x11 configuration (not Linux)."
        return 0
    fi

    section "x11"
    link_dotfile "x11/.xinitrc" "${HOME}/.xinitrc"
    link_dotfile "x11/.Xresources" "${HOME}/.Xresources"

    local sys_conf="/etc/X11/xorg.conf.d/40-libinput.conf"
    local src="${DOTFILES_ROOT}/x11/40-libinput.conf"

    if [[ -L "$sys_conf" && ! -e "$sys_conf" ]]; then
        if [[ "$EUID" -eq 0 ]]; then
            warn "Removing broken symlink: $sys_conf"
            rm "$sys_conf"
        else
            warn "Broken symlink detected: $sys_conf"
            warn "To fix it manually, run:"
            warn "  sudo rm \"$sys_conf\""
            warn "  sudo ln -s \"$src\" \"$sys_conf\""
            return 0
        fi
    elif [[ -e "$sys_conf" || -L "$sys_conf" ]]; then
        warn "Already exists (skipping): $sys_conf"
        return 0
    fi

    if [[ "$EUID" -eq 0 ]]; then
        ensure_dir "$sys_conf"
        ln -s "$src" "$sys_conf"
        info "Linked: $sys_conf -> $src"
    else
        warn "System config requires root privileges."
        warn "To install 40-libinput.conf manually, run:"
        warn "  sudo mkdir -p /etc/X11/xorg.conf.d"
        warn "  sudo ln -s \"$src\" \"$sys_conf\""
    fi
}

main() {
    install_tmux
    install_nvim
    install_ai_agents
    install_lazygit
    install_ranger
    install_zsh
    install_git
    install_x11
}

main "$@"
