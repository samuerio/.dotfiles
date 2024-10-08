vim.g.fzf_layout = { down = "40%" }

vim.g.fzf_colors = {
    fg = { 'fg', 'Normal' },
    bg = { 'bg', 'Normal' },
    hl = { 'fg', 'Comment' },
    info = { 'fg', 'PreProc' },
    border = { 'fg', 'Ignore' },
    prompt = { 'fg', 'Conditional' },
    pointer = { 'fg', 'Exception' },
    marker = { 'fg', 'Keyword' },
    spinner = { 'fg', 'Label' },
    header = { 'fg', 'Comment' },
}
vim.g.fzf_colors['fg+'] = { 'fg', 'CursorLine', 'CursorColumn', 'Normal' }
vim.g.fzf_colors['bg+'] = { 'bg', 'CursorLine', 'CursorColumn' }
vim.g.fzf_colors['hl+'] = { 'fg', 'Statement' }

vim.g['fzf_action'] = {
    ['ctrl-t'] = 'tab split',
    ['ctrl-s'] = 'split',
    ['ctrl-v'] = 'vsplit',
}

vim.g.fzf_history_dir = '~/.local/share/fzf-history'

utils.nmap('<leader>f', ':Files <CR>')
utils.nmap('<leader>h', ':Ag <CR>')
utils.nmap('<leader>;', ':History:<CR>')

vim.cmd([[
    command! -bang -nargs=* Ag call fzf#vim#ag(<q-args>, {'options': '--delimiter : --nth 4..'}, <bang>0)
]])
