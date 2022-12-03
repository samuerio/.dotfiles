-- Lua API:
-- * https://neovim.io/doc/user/api.html

vim.cmd("source ~/.config/nvim/plugins.vim")

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
vim.opt.undodir = '~/.vim/undodir'
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

--------------------------------------------------------------------------------
-- Features
--------------------------------------------------------------------------------

vim.cmd('syntax on')
vim.cmd('colorscheme onehalflight')



