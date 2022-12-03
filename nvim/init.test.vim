""修复<C-c>无法触发【InsertLeave】事件的问题
"" inoremap <C-c> <Esc>
"inoremap <C-c> <Nop>
"nnoremap <SPACE> <Nop>

"noremap <Up>    <Nop>
"noremap <Down>  <Nop>
"noremap <Left>  <Nop>
"noremap <Right> <Nop>

"nnoremap d "_d
"vnoremap d "_d
"nnoremap D "_D

"" nnoremap , <Nop>
"nnoremap ,, ,

"" 非常好用, 场景: 清理完多余信息后, 再快速回到原来编辑的位置
"nnoremap <silent>,gi gi

"" ,作为第二leader键
"nnoremap ,d "+d
"vnoremap ,d "+d
"nnoremap ,D "+D

"nnoremap c "_c
"vnoremap c "_c
"nnoremap C "_C
"nnoremap S "_S

"nnoremap x "_x
"vnoremap x "_x

"set clipboard=unnamedplus


"nnoremap <silent>Q :qa<CR>
"nnoremap <silent>X :wincmd c<CR>
"nnoremap <silent>S :w<CR>
"nnoremap <silent>L S



"" <C-i> and <Tab> are strictly equivalent.会影响C-i的功能,不要用
"" nnoremap <tab> %
"" vnoremap <tab> %

""tab 
"nnoremap tn  :tabnew<CR>
"nnoremap tl  :tabnext<CR>
"nnoremap th  :tabprev<CR>
"nnoremap to  :tabonly<CR>
"nmap <silent> tp :exe "tabn ".g:lasttab<CR>
"let g:lasttab = 1
"au TabLeave * let g:lasttab = tabpagenr()

"nnoremap <silent> <c-n> :nohlsearch<CR>

set exrc
set relativenumber
set nu
set hidden
set noerrorbells
set tabstop=4 softtabstop=4
set shiftwidth=4
set expandtab
set smartindent
set autoindent
set nowrap
set noswapfile
set nobackup
set nowritebackup
set undodir=~/.vim/undodir
set undofile
set incsearch
set termguicolors
set scrolloff=8

""noshowmode
""completeopt=menuone,noinsert,noselect
"set colorcolumn=80
"set signcolumn=yes
"set cmdheight=2
"set updatetime=300
"" Don't pass messages to |ins-completion-menu|.
"set shortmess+=c
"if has('macunix')
"    set rtp+=/opt/homebrew/opt/fzf
"endif
"set nrformats=
"set concealcursor=
"set conceallevel=2

call plug#begin()
Plug 'sonph/onehalf', { 'rtp': 'vim' }
call plug#end()
" Color
set t_Co=256

syntax on
"set background=dark
set background=light
colorscheme onehalflight

