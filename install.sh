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
    if [[ "$(uname -s)" == "Darwin" ]]; then
        link_dotfile "lazygit/config.yml" "${HOME}/Library/Application Support/lazygit/config.yml"
    else
        link_dotfile "lazygit" "${HOME}/.config/lazygit"
    fi
}

install_yabai() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        section "yabai"
        warn "Skipping yabai configuration (not macOS)."
        return 0
    fi

    section "yabai"
    link_dotfile "yabai" "${HOME}/.config/yabai"
}

install_spacebar() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        section "spacebar"
        warn "Skipping spacebar configuration (not macOS)."
        return 0
    fi

    section "spacebar"
    link_dotfile "spacebar" "${HOME}/.config/spacebar"
}

install_skhd() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        section "skhd"
        warn "Skipping skhd configuration (not macOS)."
        return 0
    fi

    section "skhd"
    link_dotfile "skhd" "${HOME}/.config/skhd"
}

install_karabiner() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        section "karabiner"
        warn "Skipping karabiner configuration (not macOS)."
        return 0
    fi

    section "karabiner"
    link_dotfile "karabiner/karabiner.json" "${HOME}/.config/karabiner/karabiner.json"
}

install_vscode() {
    section "vscode"

    local vscode_user
    if [[ "$(uname -s)" == "Darwin" ]]; then
        vscode_user="${HOME}/Library/Application Support/Code/User"
    else
        vscode_user="${HOME}/.config/Code - OSS/User"
    fi

    link_dotfile "vscode/settings.json" "${vscode_user}/settings.json"
    link_dotfile "vscode/keybindings.json" "${vscode_user}/keybindings.json"
}

install_rime() {
    section "rime"

    local os
    os="$(uname -s)"

    local rime_dir
    local src_dir_name
    local dropbox_rime

    if [[ "$os" == "Darwin" ]]; then
        rime_dir="${HOME}/Library/Rime"
        src_dir_name="mac_rime"
        dropbox_rime="${HOME}/Dropbox/Conf/mac_rime"
    elif [[ "$os" == "Linux" ]]; then
        rime_dir="${HOME}/.local/share/fcitx5/rime"
        src_dir_name="linux_rime"
        dropbox_rime="${HOME}/Dropbox/Conf/linux_rime"
    else
        warn "Skipping rime configuration (unsupported OS: ${os})."
        return 0
    fi

    local src_dir="${DOTFILES_ROOT}/${src_dir_name}"

    # Link dotfiles-managed configs
    for item in "${src_dir}"/*; do
        [[ -e "$item" ]] || continue
        local name
        name=$(basename "$item")
        [[ "$name" == ".gitignore" ]] && continue
        link_dotfile "${src_dir_name}/${name}" "${rime_dir}/${name}"
    done

    # Link Dropbox-hosted large dictionaries and model
    if [[ -d "$dropbox_rime" ]]; then
        for item in "${dropbox_rime}"/*; do
            [[ -e "$item" ]] || continue
            local name
            name=$(basename "$item")
            local target="${rime_dir}/${name}"

            if [[ -L "$target" && ! -e "$target" ]]; then
                warn "Removing broken symlink: $target"
                rm "$target"
            elif [[ -e "$target" || -L "$target" ]]; then
                warn "Already exists (skipping): $target"
                continue
            fi

            ensure_dir "$target"
            ln -s "$item" "$target"
            info "Linked: $target -> $item"
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
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "alacritty"
        warn "Skipping alacritty configuration (not Linux)."
        return 0
    fi

    section "alacritty"
    link_dotfile "alacritty" "${HOME}/.config/alacritty"
}

install_i3() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "i3"
        warn "Skipping i3 configuration (not Linux)."
        return 0
    fi

    section "i3"
    link_dotfile "i3" "${HOME}/.config/i3"
}

install_polybar() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "polybar"
        warn "Skipping polybar configuration (not Linux)."
        return 0
    fi

    section "polybar"
    link_dotfile "polybar" "${HOME}/.config/polybar"
}

install_redshift() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "redshift"
        warn "Skipping redshift configuration (not Linux)."
        return 0
    fi

    section "redshift"
    link_dotfile "redshift" "${HOME}/.config/redshift"
}

install_rofi() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "rofi"
        warn "Skipping rofi configuration (not Linux)."
        return 0
    fi

    section "rofi"
    link_dotfile "rofi" "${HOME}/.config/rofi"
}

install_zathura() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "zathura"
        warn "Skipping zathura configuration (not Linux)."
        return 0
    fi

    section "zathura"
    link_dotfile "zathura" "${HOME}/.config/zathura"
}

install_dunst() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "dunst"
        warn "Skipping dunst configuration (not Linux)."
        return 0
    fi

    section "dunst"
    link_dotfile "dunst" "${HOME}/.config/dunst"
}

install_feh() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "feh"
        warn "Skipping feh configuration (not Linux)."
        return 0
    fi

    section "feh"
    link_dotfile "feh" "${HOME}/.config/feh"
}

install_mimeapps() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "mimeapps"
        warn "Skipping mimeapps.list configuration (not Linux)."
        return 0
    fi

    section "mimeapps"
    link_dotfile "mimeapps.list" "${HOME}/.config/mimeapps.list"
}

install_systemd() {
    if [[ "$(uname -s)" != "Linux" ]]; then
        section "systemd"
        warn "Skipping systemd configuration (not Linux)."
        return 0
    fi

    section "systemd"
    local src_dir="${DOTFILES_ROOT}/systemd"
    local sys_dir="/etc/systemd/system"

    for item in "${src_dir}"/*; do
        [[ -e "$item" ]] || continue
        local name
        name=$(basename "$item")
        local sys_conf="${sys_dir}/${name}"

        if [[ -L "$sys_conf" && ! -e "$sys_conf" ]]; then
            if [[ "$EUID" -eq 0 ]]; then
                warn "Removing broken symlink: $sys_conf"
                rm "$sys_conf"
            else
                warn "Broken symlink detected: $sys_conf"
                warn "To fix it manually, run:"
                warn "  sudo rm \"$sys_conf\""
                warn "  sudo ln -s \"$item\" \"$sys_conf\""
                continue
            fi
        elif [[ -e "$sys_conf" || -L "$sys_conf" ]]; then
            warn "Already exists (skipping): $sys_conf"
            continue
        fi

        if [[ "$EUID" -eq 0 ]]; then
            ensure_dir "$sys_conf"
            ln -s "$item" "$sys_conf"
            info "Linked: $sys_conf -> $item"
        else
            warn "Systemd config requires root privileges."
            warn "To install ${name} manually, run:"
            warn "  sudo ln -s \"$item\" \"$sys_conf\""
        fi
    done
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
}

main "$@"
