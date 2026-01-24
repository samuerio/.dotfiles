-- Lua API:
-- * https://neovim.io/doc/user/api.html

vim.g.mapleader = ' '

-- Globally export my utilities
require('utils')

--------------------------------------------------------------------------------
-- Plugins configuration
--------------------------------------------------------------------------------

vim.cmd("source ~/.config/nvim/plugins.vim")
require('config')

--------------------------------------------------------------------------------
-- Main options
--------------------------------------------------------------------------------

vim.opt.exrc = true
vim.opt.relativenumber = true
vim.opt.nu = true
vim.opt.hidden = true
vim.opt.errorbells = false
vim.opt.tabstop = 4
vim.opt.softtabstop = 4
vim.opt.shiftwidth = 4
vim.opt.expandtab = true
vim.opt.smartindent = true
vim.opt.autoindent = true
vim.opt.wrap = false
vim.opt.swapfile = false
vim.opt.backup = false
vim.opt.writebackup = false
vim.opt.undodir = os.getenv("HOME") .. "/.vim/undodir"
vim.opt.undofile = true
vim.opt.incsearch = true
vim.opt.termguicolors = true
vim.opt.scrolloff = 8
vim.opt.colorcolumn = '80'
vim.opt.signcolumn = 'yes'
vim.opt.cmdheight = 2
vim.opt.updatetime = 300
vim.opt.shortmess = vim.opt.shortmess + 'c'
if vim.fn.has('macunix') then
    vim.opt.rtp = vim.opt.rtp + '/opt/homebrew/opt/fzf'
end
vim.opt.nrformats = ''
vim.opt.concealcursor = ''
vim.opt.conceallevel = 0
vim.opt.background = 'light'
vim.opt.mouse = 'a'
vim.opt.cursorline = true
vim.opt.foldopen = vim.opt.foldopen - 'block'
vim.opt.clipboard = 'unnamedplus'
vim.opt.laststatus = 2
vim.opt.foldlevelstart = 99
vim.opt.fileencodings = "utf-8,gbk"

--------------------------------------------------------------------------------
-- Features
--------------------------------------------------------------------------------

vim.cmd('syntax on')
vim.cmd('colorscheme onehalf-lush')

--------------------------------------------------------------------------------
-- Useful mappings
--------------------------------------------------------------------------------

utils.imap('<C-c>', '<Nop>')
utils.nmap('<SPACE>', '<Nop>')

utils.nmap('<Up>', '<Nop>')
utils.nmap('<Down>', '<Nop>')
utils.nmap('<Left>', '<Nop>')
utils.nmap('<Right>', '<Nop>')

-- delete
utils.nmap('d', '"_d')
utils.nmap('D', '"_D')
utils.nmap('c', '"_c')
utils.nmap('C', '"_C')
utils.nmap('S', '"_S')
utils.nmap('x', '"_x')
utils.vmap('d', '"_d')
utils.vmap('c', '"_c')

-- cut
utils.vmap('x', '"+x')

-- quick save, quit, insert
utils.nmap('Q', ':qa<CR>')
utils.nmap('S', ':w<CR>')
-- utils.nmap('L', '"_S') 使用cc替代

-- window
utils.nmap('<C-h>', '<C-w>h')
utils.nmap('<C-j>', '<C-w>j')
utils.nmap('<C-k>', '<C-w>k')
utils.nmap('<C-l>', '<C-w>l')
utils.nmap('<C-p>', '<C-w><C-p>')

utils.nmap('X', ':wincmd c<CR>')
utils.nmap('<C-t>', ':wincmd T<CR>')
utils.nmap('<C-s>', ':wincmd s<CR>')

utils.nmap('<leader>cv', ':windo wincmd H<CR>')
utils.nmap('<leader>cs', ':windo wincmd K<CR>')

-- tab
utils.nmap('tn', ':tabnew<CR>')
utils.nmap('tl', ':tabnext<CR>')
utils.nmap('th', ':tabprev<CR>')
utils.nmap('to', ':tabonly<CR>')
utils.nmap('tp', ':exe "tabn ".g:lasttab<CR>')
vim.g.lasttab = 1
vim.api.nvim_create_autocmd(
    { "TabLeave" },
    { pattern = "*", command = "let g:lasttab = tabpagenr()" }
)

-- buffer
utils.nmap('[b', ':bprevious<CR>')
utils.nmap(']b', ':bnext<CR>')

-- last edit
utils.nmap("'i", "gi")
utils.nmap("'l", "'I")
vim.api.nvim_create_autocmd(
    { "InsertLeave" },
    { pattern = "*", command = "execute 'normal! mI'" }
)

utils.nmap('<C-n>', ':nohlsearch<CR>')

-- command complete
vim.cmd([[
    function! s:wildchar()
        call feedkeys("\<Tab>", 'nt')
        return ''
    endfunction

    cnoremap <expr> <C-j> pumvisible() ? "\<C-n>" : "\<C-r>=<SID>wildchar()<CR>"
    cnoremap <expr> <C-k> pumvisible() ? "\<C-p>" : "\<C-k>"
]])

-- paste
utils.nmap('<leader>p', ':<C-u>set paste<cr>')
utils.nmap('<leader>P', ':<C-u>set nopaste<cr>')

utils.nmap('cp', ':let @+ = expand("%")<cr>')
utils.nmap('cn', ':let @+ = expand("%:t")<cr>')



--------------------------------------------------------------------------------
-- Colorscheme
--------------------------------------------------------------------------------

-- 我们当前启用的是GUI color，所以cterm的配置并没生效，生效的是gui
vim.cmd([[
    hi IncSearch ctermfg=231 ctermbg=71 guifg=#fafafa guibg=#50a14f
    hi Search ctermfg=248 ctermbg=71 guifg=#fafafa guibg=#50a14f
]])

-- 自定义diff主题
vim.cmd([[
    hi DiffAdd      gui=none    guifg=NONE          guibg=#bada9f
    hi DiffChange   gui=none    guifg=NONE          guibg=#e5d5ac
    hi DiffDelete   gui=bold    guifg=#ff8080       guibg=#ffb0b0
    hi DiffText     gui=none    guifg=NONE          guibg=#8cbee2
]])

--------------------------------------------------------------------------------
-- Todo
--------------------------------------------------------------------------------

vim.cmd([[
    " 定制todo.txt
    autocmd BufNewFile,BufRead *.todo.txt set ft=todo
    autocmd BufNewFile,BufRead *.done.txt set ft=done
    autocmd BufNewFile,BufRead *.report.txt set ft=report
    autocmd FileType todo nmap <buffer><silent> <leader>i :call mdip#MarkdownClipboardImage()<CR>
    autocmd FileType todo set wrap linebreak ignorecase
    " 匹配不包含|的任何字符, 作用于todo表格与任务列表
    autocmd FileType todo syntax match DoneTodoMatch /^x [^|]*/
    autocmd FileType todo hi def  DoneTodoColor ctermfg=231 ctermbg=71 guifg=#fafafa guibg=#50a14f
    autocmd FileType todo hi link DoneTodoMatch DoneTodoColor
    autocmd FileType todo call coc#rpc#stop()
    autocmd FileType report syntax match DoneTodoCell / x [^|]*/
    autocmd FileType report hi def  DoneTodoColor ctermfg=231 ctermbg=71 guifg=#fafafa guibg=#50a14f
    autocmd FileType report hi link DoneTodoCell DoneTodoColor
    " 启用会导致}{的移动变慢, 因为多增加了}| \ {|移动方式
    autocmd FileType report call tablemode#Enable()

]])

--------------------------------------------------------------------------------
-- Other
--------------------------------------------------------------------------------

vim.g.markdown_fenced_languages = { 'html', 'python', 'bash=sh', 'java', 'rust', 'go', 'css',
    'javascript', 'js=javascript', 'c', 'cpp', 'sql', 'json', 'yaml', 'lua' }
vim.g.markdown_minlines = 1000

vim.g.java_ignore_markdown = 1
vim.g.java_ignore_html = 1

if vim.fn.has('unix') then
    vim.api.nvim_create_autocmd(
        { "InsertLeave", "BufCreate", "BufEnter", "BufLeave" },
        { pattern = "*", command = ":silent !fcitx5-remote -c" }
    )
end
