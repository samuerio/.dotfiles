# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:/usr/local/bin:$PATH

# Path to your oh-my-zsh installation.
export ZSH="$HOME/.oh-my-zsh"

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time oh-my-zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
ZSH_THEME="powerlevel10k/powerlevel10k"
#ZSH_THEME="robbyrussell"
#ZSH_THEME="agnoster"

# Set list of themes to pick from when loading at random
# Setting this variable when ZSH_THEME=random will cause zsh to load
# a theme from this variable instead of looking in $ZSH/themes/
# If set to an empty array, this variable will have no effect.
# ZSH_THEME_RANDOM_CANDIDATES=( "robbyrussell" "agnoster" )

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment one of the following lines to change the auto-update behavior
# zstyle ':omz:update' mode disabled  # disable automatic updates
# zstyle ':omz:update' mode auto      # update automatically without asking
# zstyle ':omz:update' mode reminder  # just remind me to update when it's time

# Uncomment the following line to change how often to auto-update (in days).
# zstyle ':omz:update' frequency 13

# Uncomment the following line if pasting URLs and other text is messed up.
# DISABLE_MAGIC_FUNCTIONS="true"

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# You can also set it to another string to have that shown instead of the default red dots.
# e.g. COMPLETION_WAITING_DOTS="%F{yellow}waiting...%f"
# Caution: this setting can cause issues with multiline prompts in zsh < 5.7.1 (see #5765)
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
# HIST_STAMPS="mm/dd/yyyy"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load?
# Standard plugins can be found in $ZSH/plugins/
# Custom plugins may be added to $ZSH_CUSTOM/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(
    git
    tmux
    autojump
    # zsh-syntax-highlighting
    # zsh-autosuggestions
)

source $ZSH/oh-my-zsh.sh

# User configuration

# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
# if [[ -n $SSH_CONNECTION ]]; then
#   export EDITOR='vim'
# else
#   export EDITOR='mvim'
# fi

# Compilation flags
# export ARCHFLAGS="-arch x86_64"

# Set personal aliases, overriding those provided by oh-my-zsh libs,
# plugins, and themes. Aliases can be placed here, though oh-my-zsh
# users are encouraged to define aliases within the ZSH_CUSTOM folder.
# For a full list of active aliases, run `alias`.
#
# Example aliases
# alias zshconfig="mate ~/.zshrc"
# alias ohmyzsh="mate ~/.oh-my-zsh"
alias nzsh="nvim ~/.zshrc"
alias szsh="source ~/.zshrc"
alias vimdiff='nvim -d'
alias ps="ps -ef | grep"
alias lg='lazygit'
alias uvpn= 'unset https_proxy http_proxy all_proxy'
# 确保sudo的时候，保留原来的环境变量，保证sudo nvim能使用自定义配置
alias sudo='sudo -E'
alias ra='ranger'

#expect脚本会导致rz、sz无法生效
#alias kbk='expect ~/.kpy'
#alias bk='expect ~/.nkpy'
alias bk='ssh -p 2222 zhe@10.12.3.5'

if [[ $(uname) == "Darwin" ]]; then
    # 针对 macOS 的命令
    alias vpn='export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 all_proxy=socks5://127.0.0.1:7897'
    alias nd='cd ~/source/github/.dotfiles && nvim ./'

    alias nn='cd ~/Dropbox/EXP/Notes && nvim ./'
    alias ns='cd ~/Dropbox/EXP/Scripts && nvim ./'
    alias nt='cd ~/Dropbox/GTD/Todo && nvim ./'
    alias nr='cd ~/Dropbox/GTD/Daily_Report && nvim ./'
    alias no='cd ~/Dropbox/GTD/OKR && nvim ./'

    #待整理-----
    [ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

    source ~/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

    [ -f /opt/homebrew/etc/profile.d/autojump.sh ] && . /opt/homebrew/etc/profile.d/autojump.sh

    # Set CLICOLOR if you want Ansi Colors in iTerm2
    export CLICOLOR=1

    # 使用brew安装后就不需要设置如下环境变量将可执行包引入了, brew会将可执行包放在/usr/local/bin
    # export PYTHON3_HOME=/Users/zhenghe/Library/Python/3.8
    # export PATH=$PYTHON3_HOME/bin:$PATH

    # 使用brew安装后就不需要设置如下环境变量将可执行包引入了, brew会将可执行包放在/usr/local/bin
    # export GOPATH=/Users/zhenghe/repo/go
    # export PATH=$GOPATH/bin:$PATH


    #If you need to have openjdk@17 first in your PATH, run:
    #echo 'export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"' >> ~/.zshrc
    #export JAVA_HOME=/Library/Java/JavaVirtualMachines/adoptopenjdk-8.jdk/Contents/Home
    export JAVA_HOME=/opt/homebrew/opt/openjdk@17
    export PATH=$JAVA_HOME/bin:$PATH

    # lotus
    export LIBRARY_PATH=/opt/homebrew/lib
    export FFI_BUILD_FROM_SOURCE=1

    export PYENV_ROOT="$HOME/.pyenv"
    export PATH="$PYENV_ROOT/bin:$PATH"
    if command -v pyenv 1>/dev/null 2>&1; then
      eval "$(pyenv init --path)"
      eval "$(pyenv init -)"
    fi

    setopt no_nomatch

    export PATH="$PATH:/Users/zhenghe/.foundry/bin"
    export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
    export PATH="/opt/homebrew/opt/openssl@1.1/bin:$PATH"

elif [[ $(uname) == "Linux" ]]; then
    # 针对 Linux 的命令
    alias vpn='export https_proxy=http://172.29.48.1:7890 http_proxy=http://172.29.48.1:7890 all_proxy=socks5://172.29.48.1:7890'
    alias nd='cd ~/github/samuerio/.dotfiles && nvim ./'

    # alias kvpn='sudo openvpn --daemon --config ~/.config/openvpn/kaopuyun.ovpn'

    [ -f /usr/share/fzf/key-bindings.zsh ] && source /usr/share/fzf/key-bindings.zsh
    [ -f /usr/share/fzf/completion.zsh ] && source /usr/share/fzf/completion.zsh

    source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

    export PATH=$HOME/.local/bin:$PATH

    alias nn='cd /mnt/c/Users/36001/Dropbox/EXP/Notes && nvim ./'
    alias nt='cd /mnt/c/Users/36001/Dropbox/GTD/Todo && nvim ./'
    alias nr='cd /mnt/c/Users/36001/Dropbox/GTD/Daily_Report && nvim ./'
    alias no='cd /mnt/c/Users/36001/Dropbox/GTD/OKR && nvim ./'
else
fi

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

export PATH=$HOME/.cargo/bin:$PATH

export LC_ALL=en_US.UTF-8
export LANG=en_US.UTF-8

export BAT_THEME="Monokai Extended Light"
export RANGER_LOAD_DEFAULT_RC=FALSE

export VISUAL=nvim
export EDITOR="$VISUAL"
export TERM=xterm-256color

