#!/usr/bin/env bash
set -euo pipefail

# Dotfiles installation script
# Usage: ./install.sh

DOTFILES_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS_NAME="$(uname -s)"

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

skip_unless_os() {
    local expected_os="$1"
    local name="$2"
    local label="$3"

    if [[ "$OS_NAME" != "$expected_os" ]]; then
        section "$name"
        warn "Skipping $name configuration (not ${label})."
        return 1
    fi

    return 0
}

skip_unless_darwin() {
    skip_unless_os "Darwin" "$1" "macOS"
}

skip_unless_linux() {
    skip_unless_os "Linux" "$1" "Linux"
}

link_path() {
    local src="$1"
    local target="$2"

    if [[ ! -e "$src" && ! -L "$src" ]]; then
        err "Source does not exist: $src"
        return 1
    fi

    ensure_dir "$target"

    if [[ -L "$target" && ! -e "$target" ]]; then
        warn "Removing broken symlink: $target"
        rm "$target"
    elif [[ -e "$target" || -L "$target" ]]; then
        warn "Already exists (skipping): $target"
        return 0
    fi

    ln -s "$src" "$target"
    info "Linked: $target -> $src"
}

# Create a symbolic link from source (relative to DOTFILES_ROOT) to target
link_dotfile() {
    local src_rel="$1"
    local target="$2"
    link_path "${DOTFILES_ROOT}/${src_rel}" "$target"
}

# Create a symbolic link from an external absolute source to target
link_external() {
    local src="$1"
    local target="$2"
    link_path "$src" "$target"
}

link_dir_contents() {
    local src_dir_name="$1"
    local target_dir="$2"
    local src_dir="${DOTFILES_ROOT}/${src_dir_name}"
    local item name

    for item in "${src_dir}"/*; do
        [[ -e "$item" ]] || continue
        name="$(basename "$item")"
        [[ "$name" == ".gitignore" ]] && continue
        link_dotfile "${src_dir_name}/${name}" "${target_dir}/${name}"
    done
}

link_system_file() {
    local src="$1"
    local target="$2"
    local description="$3"

    if [[ ! -e "$src" && ! -L "$src" ]]; then
        err "Source does not exist: $src"
        return 1
    fi

    if [[ -L "$target" && ! -e "$target" ]]; then
        if [[ "$EUID" -eq 0 ]]; then
            warn "Removing broken symlink: $target"
            rm "$target"
        else
            warn "Broken symlink detected: $target"
            warn "To fix it manually, run:"
            warn "  sudo rm \"$target\""
            warn "  sudo ln -s \"$src\" \"$target\""
            return 0
        fi
    elif [[ -e "$target" || -L "$target" ]]; then
        warn "Already exists (skipping): $target"
        return 0
    fi

    if [[ "$EUID" -eq 0 ]]; then
        ensure_dir "$target"
        ln -s "$src" "$target"
        info "Linked: $target -> $src"
    else
        warn "$description requires root privileges."
        warn "To install it manually, run:"
        warn "  sudo mkdir -p \"$(dirname "$target")\""
        warn "  sudo ln -s \"$src\" \"$target\""
    fi
}

install_platform_dotfile() {
    local name="$1"
    local expected_os="$2"
    local label="$3"
    local src_rel="$4"
    local target="$5"

    skip_unless_os "$expected_os" "$name" "$label" || return 0
    section "$name"
    link_dotfile "$src_rel" "$target"
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

    local dropbox_settings="${HOME}/Dropbox/Conf/pi-coding-agent/settings.json"
    local agent_settings="${HOME}/.pi/agent/settings.json"

    if [[ -e "$dropbox_settings" || -L "$dropbox_settings" ]]; then
        link_external "$dropbox_settings" "$agent_settings"
    else
        warn "Dropbox settings not found: $dropbox_settings"
    fi
}

install_lazygit() {
    section "lazygit"
    if [[ "$OS_NAME" == "Darwin" ]]; then
        link_dotfile "lazygit/config.yml" "${HOME}/Library/Application Support/lazygit/config.yml"
    else
        link_dotfile "lazygit" "${HOME}/.config/lazygit"
    fi
}

install_yabai() {
    install_platform_dotfile "yabai" "Darwin" "macOS" "yabai" "${HOME}/.config/yabai"
}

install_spacebar() {
    install_platform_dotfile "spacebar" "Darwin" "macOS" "spacebar" "${HOME}/.config/spacebar"
}

install_skhd() {
    install_platform_dotfile "skhd" "Darwin" "macOS" "skhd" "${HOME}/.config/skhd"
}

install_karabiner() {
    install_platform_dotfile "karabiner" "Darwin" "macOS" "karabiner/karabiner.json" "${HOME}/.config/karabiner/karabiner.json"
}

install_vscode() {
    section "vscode"

    local vscode_user
    if [[ "$OS_NAME" == "Darwin" ]]; then
        vscode_user="${HOME}/Library/Application Support/Code/User"
    else
        vscode_user="${HOME}/.config/Code - OSS/User"
    fi

    link_dotfile "vscode/settings.json" "${vscode_user}/settings.json"
    link_dotfile "vscode/keybindings.json" "${vscode_user}/keybindings.json"
}

install_rime() {
    section "rime"

    local rime_dir
    local src_dir_name
    local dropbox_rime

    if [[ "$OS_NAME" == "Darwin" ]]; then
        rime_dir="${HOME}/Library/Rime"
        src_dir_name="mac_rime"
        dropbox_rime="${HOME}/Dropbox/Conf/mac_rime"
    elif [[ "$OS_NAME" == "Linux" ]]; then
        rime_dir="${HOME}/.local/share/fcitx5/rime"
        src_dir_name="linux_rime"
        dropbox_rime="${HOME}/Dropbox/Conf/linux_rime"
    else
        warn "Skipping rime configuration (unsupported OS: ${OS_NAME})."
        return 0
    fi

    # Link dotfiles-managed configs
    link_dir_contents "$src_dir_name" "$rime_dir"

    # Link Dropbox-hosted large dictionaries and model
    if [[ -d "$dropbox_rime" ]]; then
        local item name
        for item in "${dropbox_rime}"/*; do
            [[ -e "$item" ]] || continue
            name="$(basename "$item")"
            link_external "$item" "${rime_dir}/${name}"
        done
    else
        warn "Dropbox ${src_dir_name} not found: ${dropbox_rime}"
    fi
}

install_ranger() {
    section "ranger"
    link_dotfile "ranger" "${HOME}/.config/ranger"
}

install_zsh() {
    section "zsh"
    link_dotfile "zsh/.zshrc" "${HOME}/.zshrc"
    link_dotfile "zsh/.p10k.zsh" "${HOME}/.p10k.zsh"
    link_dotfile "zsh/my_patches.zsh" "${HOME}/.oh-my-zsh/custom/my_patches.zsh"

    local dropbox_zshenv="${HOME}/Dropbox/Conf/zshenv"
    local target_zshenv="${HOME}/.zshenv"

    if [[ -e "$dropbox_zshenv" || -L "$dropbox_zshenv" ]]; then
        link_external "$dropbox_zshenv" "$target_zshenv"
    else
        warn "Dropbox zshenv not found: $dropbox_zshenv"
    fi
}

install_git() {
    section "git"
    link_dotfile "git/.gitconfig" "${HOME}/.gitconfig"
}

install_ghostty() {
    section "ghostty"
    link_dotfile "ghostty" "${HOME}/.config/ghostty"
}

install_uv() {
    section "uv"
    link_dotfile "uv" "${HOME}/.config/uv"
}

install_alacritty() {
    install_platform_dotfile "alacritty" "Linux" "Linux" "alacritty" "${HOME}/.config/alacritty"
}

install_i3() {
    install_platform_dotfile "i3" "Linux" "Linux" "i3" "${HOME}/.config/i3"
}

install_polybar() {
    install_platform_dotfile "polybar" "Linux" "Linux" "polybar" "${HOME}/.config/polybar"
}

install_redshift() {
    install_platform_dotfile "redshift" "Linux" "Linux" "redshift" "${HOME}/.config/redshift"
}

install_rofi() {
    install_platform_dotfile "rofi" "Linux" "Linux" "rofi" "${HOME}/.config/rofi"
}

install_zathura() {
    install_platform_dotfile "zathura" "Linux" "Linux" "zathura" "${HOME}/.config/zathura"
}

install_dunst() {
    install_platform_dotfile "dunst" "Linux" "Linux" "dunst" "${HOME}/.config/dunst"
}

install_feh() {
    install_platform_dotfile "feh" "Linux" "Linux" "feh" "${HOME}/.config/feh"
}

install_mimeapps() {
    install_platform_dotfile "mimeapps" "Linux" "Linux" "mimeapps.list" "${HOME}/.config/mimeapps.list"
}

install_systemd() {
    skip_unless_linux "systemd" || return 0
    section "systemd"

    local src_dir="${DOTFILES_ROOT}/systemd"
    local sys_dir="/etc/systemd/system"
    local item name

    for item in "${src_dir}"/*; do
        [[ -e "$item" ]] || continue
        name="$(basename "$item")"
        link_system_file "$item" "${sys_dir}/${name}" "Systemd config"
    done
}

install_desktop() {
    skip_unless_linux "desktop" || return 0
    section "desktop"
    link_dir_contents "desktop" "${HOME}/.local/share/applications"
}

install_x11() {
    skip_unless_linux "x11" || return 0
    section "x11"
    link_dotfile "x11/.xinitrc" "${HOME}/.xinitrc"
    link_dotfile "x11/.Xresources" "${HOME}/.Xresources"

    link_system_file \
        "${DOTFILES_ROOT}/x11/40-libinput.conf" \
        "/etc/X11/xorg.conf.d/40-libinput.conf" \
        "System config"
}

main() {
    local installers=(
        install_tmux
        install_nvim
        install_ai_agents
        install_lazygit
        install_ranger
        install_zsh
        install_git
        install_yabai
        install_spacebar
        install_skhd
        install_karabiner
        install_vscode
        install_rime
        install_ghostty
        install_uv
        install_alacritty
        install_i3
        install_polybar
        install_redshift
        install_rofi
        install_zathura
        install_dunst
        install_feh
        install_mimeapps
        install_systemd
        install_x11
        install_desktop
    )
    local installer

    for installer in "${installers[@]}"; do
        "$installer"
    done
}

main "$@"
