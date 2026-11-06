ZSH_AUTOSUGGEST_STRATEGY=(completion)
#配置高亮样式,会让szsh,sourcezsh配置很慢
ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE="fg=#99CCEE"
ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20

# pi agent bin (fd, schedule CLI). Appended last so repo-shipped binaries never
# shadow an already-installed command.
export PATH="$PATH:$HOME/.pi/agent/bin"
