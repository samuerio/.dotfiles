"修复<C-c>无法触发【InsertLeave】事件的问题
" inoremap <C-c> <Esc>
inoremap <C-c> <Nop>
nnoremap <SPACE> <Nop>

noremap <Up>    <Nop>
noremap <Down>  <Nop>
noremap <Left>  <Nop>
noremap <Right> <Nop>

nnoremap d "_d
vnoremap d "_d
nnoremap D "_D

" nnoremap , <Nop>
nnoremap ,, ,

" 非常好用, 场景: 清理完多余信息后, 再快速回到原来编辑的位置
nnoremap <silent>,gi gi

" ,作为第二leader键
nnoremap ,d "+d
vnoremap ,d "+d
nnoremap ,D "+D

nnoremap c "_c
vnoremap c "_c
nnoremap C "_C
nnoremap S "_S

nnoremap x "_x
vnoremap x "_x

set clipboard=unnamedplus


nnoremap <silent>Q :qa<CR>
nnoremap <silent>X :wincmd c<CR>
nnoremap <silent>S :w<CR>
nnoremap <silent>L S



" <C-i> and <Tab> are strictly equivalent.会影响C-i的功能,不要用
" nnoremap <tab> %
" vnoremap <tab> %

"tab 
nnoremap tn  :tabnew<CR>
nnoremap tl  :tabnext<CR>
nnoremap th  :tabprev<CR>
nnoremap to  :tabonly<CR>
nmap <silent> tp :exe "tabn ".g:lasttab<CR>
let g:lasttab = 1
au TabLeave * let g:lasttab = tabpagenr()

nnoremap <silent> <c-n> :nohlsearch<CR>

set exrc
"set guicursor=
set relativenumber
set nu
"set nohlsearch
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
"noshowmode
"completeopt=menuone,noinsert,noselect
set completeopt=menu,menuone,preview,noinsert,noselect
set colorcolumn=80
set signcolumn=yes
set cmdheight=2
set updatetime=300
" Don't pass messages to |ins-completion-menu|.
set shortmess+=c
if has('macunix')
    set rtp+=/opt/homebrew/opt/fzf
endif
set nrformats=
set concealcursor=
set conceallevel=2

function! s:wildchar()
    call feedkeys("\<Tab>", 'nt')
    return ''
endfunction

cnoremap <expr> <C-j> pumvisible() ? "\<C-n>" : "\<C-r>=<SID>wildchar()<CR>"
cnoremap <expr> <C-k> pumvisible() ? "\<C-p>" : "\<C-k>"

call plug#begin()

" 存在代码块渲染BUG
" Plug 'preservim/vim-markdown'
" let g:vim_markdown_folding_disabled = 1

Plug 'ferrine/md-img-paste.vim'
let g:mdip_imgdir_absolute = '/Users/zhenghe/Dropbox/img'

Plug 'jiangmiao/auto-pairs'
au Filetype markdown let b:autopairs_enabled = 0
au Filetype markdown let b:AutoPairs={'(':')', '[':']', '{':'}','"':'"', '`':'`'}

" 全局单击left_control映射escape
" 配合鼠须管的vim-mode模式,解决vim下的insert模式切normal模式时,自动切鼠须管的ascill模式(不切成其他输入法)
" Plug 'brglng/vim-im-select'

" If you have nodejs and yarn
Plug 'iamcco/markdown-preview.nvim', { 'do': 'cd app && yarn install' }

Plug 'tpope/vim-commentary'

" GitGutter
Plug 'airblade/vim-gitgutter'

Plug 'kdheepak/lazygit.nvim'
" ==================== lazygit.nvim ====================
noremap <c-g> :LazyGit<CR>
let g:lazygit_floating_window_winblend = 0 " transparency of floating window
let g:lazygit_floating_window_scaling_factor = 1.0 " scaling factor for floating window
let g:lazygit_floating_window_corner_chars = ['╭', '╮', '╰', '╯'] "customize lazygit popup window corner characters
let g:lazygit_use_neovim_remote = 1 " for neovim-remote support

Plug 'lfv89/vim-interestingwords'
let g:interestingWordsGUIColors = ['#E3EDCD','#D1EAFF','#EEE8D5','#FDE6E0','#DCE2F1']

Plug 'tpope/vim-surround'
Plug 'brooth/far.vim'

Plug 'yggdroot/indentline'
"禁止indentline插件覆盖默认的concealcursor\conceallevel行为,否则会导致normal\insert\模式下都看不到隐藏的字符.问题很大
let g:indentLine_setConceal = 0

" Plug 'kien/ctrlp.vim'

Plug 'mhinz/vim-startify'
" 禁止startify自动切换目录
let g:startify_change_to_dir = 0

Plug 'sonph/onehalf', { 'rtp': 'vim' }

Plug 'junegunn/fzf', { 'do': { -> fzf#install() } }
Plug 'junegunn/fzf.vim'
let g:fzf_layout = { 'down': '40%' }
" Customize fzf colors to match your color scheme
" - fzf#wrap translates this to a set of `--color` options
let g:fzf_colors =
    \ { 'fg':      ['fg', 'Normal'],
      \ 'bg':      ['bg', 'Normal'],
      \ 'hl':      ['fg', 'Comment'],
      \ 'fg+':     ['fg', 'CursorLine', 'CursorColumn', 'Normal'],
      \ 'bg+':     ['bg', 'CursorLine', 'CursorColumn'],
      \ 'hl+':     ['fg', 'Statement'],
      \ 'info':    ['fg', 'PreProc'],
      \ 'border':  ['fg', 'Ignore'],
      \ 'prompt':  ['fg', 'Conditional'],
      \ 'pointer': ['fg', 'Exception'],
      \ 'marker':  ['fg', 'Keyword'],
      \ 'spinner': ['fg', 'Label'],
      \ 'header':  ['fg', 'Comment'] }
let g:fzf_action = {
      \ 'ctrl-t': 'tab split',
      \ 'ctrl-s': 'split',
      \ 'ctrl-v': 'vsplit' }

Plug 'scrooloose/nerdtree'
let NERDTreeMapOpenSplit = 's'
let NERDTreeMapOpenVSplit = 'v'


" Fugitive
Plug 'tpope/vim-fugitive'
Plug 'junegunn/gv.vim'

" EasyMotion
Plug 'easymotion/vim-easymotion'

" Airline
Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'
set laststatus=2
let g:airline_theme = 'onehalflight'

Plug 'freitass/todo.txt-vim'
let maplocalleader='\'

Plug 'dhruvasagar/vim-table-mode'
function! s:isAtStartOfLine(mapping)
  let text_before_cursor = getline('.')[0 : col('.')-1]
  let mapping_pattern = '\V' . escape(a:mapping, '\')
  let comment_pattern = '\V' . escape(substitute(&l:commentstring, '%s.*$', '', ''), '\')
  return (text_before_cursor =~? '^' . ('\v(' . comment_pattern . '\v)?') . '\s*\v' . mapping_pattern . '\v$')
endfunction
inoreabbrev <expr> <bar><bar>
          \ <SID>isAtStartOfLine('\|\|') ?
          \ '<c-o>:TableModeEnable<cr><bar><space><bar><left><left>' : '<bar><bar>'
inoreabbrev <expr> __
          \ <SID>isAtStartOfLine('__') ?
          \ '<c-o>:silent! TableModeDisable<cr>' : '__'
let g:table_mode_color_cells=1
let g:table_mode_syntax = 0

" 修复source vimrc报错的BUG
if !exists('g:airline_symbols')
    let g:airline_symbols = {}
endif
let g:airline_left_sep = ''
let g:airline_left_alt_sep = ''
let g:airline_right_sep = ''
let g:airline_right_alt_sep = ''
let g:airline_symbols.branch = ''
let g:airline_symbols.readonly = ''
let g:airline_symbols.linenr = '☰'
let g:airline_symbols.maxlinenr = ''
let g:airline_symbols.dirty='⚡'

" AutoCompleteRelated
"Plug 'neoclide/coc.nvim', {'branch': 'release'}

"let g:coc_snippet_next="<tab>"
"let g:coc_snippet_prev="<s-tab>"			

"" Remap keys for gotos
"" 这里就是tabe，tabe是tabe[edit]的缩写
"" nmap <silent> gt :call CocActionAsync('jumpDefinition', 'tabe')<CR>
"nmap <silent> gt :call CocActionAsync('jumpTypeDefinition', 'tabe')<CR>


Plug 'neovim/nvim-lspconfig'

Plug 'nvim-lua/plenary.nvim'

Plug 'jose-elias-alvarez/null-ls.nvim'

Plug 'simrat39/symbols-outline.nvim'

Plug 'nvim-telescope/telescope.nvim', { 'tag': '0.1.0' }

Plug 'nvim-treesitter/nvim-treesitter', {'do': ':TSUpdate'}

Plug 'nvim-telescope/telescope-fzf-native.nvim', { 'do': 'make' }

Plug 'hrsh7th/cmp-nvim-lsp'
Plug 'hrsh7th/cmp-buffer'
Plug 'hrsh7th/cmp-path'
Plug 'hrsh7th/cmp-cmdline'
Plug 'hrsh7th/cmp-nvim-lsp-signature-help'
Plug 'hrsh7th/nvim-cmp'

" For vsnip users.
Plug 'hrsh7th/cmp-vsnip'
Plug 'hrsh7th/vim-vsnip'

Plug 'nvim-tree/nvim-web-devicons' " optional, for file icons
Plug 'nvim-tree/nvim-tree.lua'

call plug#end()

"NERDTree
map <silent> <C-e> :NERDTreeToggle<CR>
let NERDTreeShowBookmarks=1
let NERDTreeIgnore=['\.py[cd]$', '\~$', '\.swo$', '\.swp$', '^\.git$', '^\.hg$', '^\.svn$', '\.bzr$']
let NERDTreeChDirMode=0
let NERDTreeQuitOnOpen=1
let NERDTreeMouseMode=2
let NERDTreeShowHidden=1
let NERDTreeKeepTreeInNewTab=1
let g:nerdtree_tabs_open_on_gui_startup=0
" NERDTrees File highlighting
function! NERDTreeHighlightFile(extension, fg, bg, guifg, guibg)
exec 'autocmd FileType nerdtree highlight ' . a:extension .' ctermbg='. a:bg .' ctermfg='. a:fg .' guibg='. a:guibg .' guifg='. a:guifg
exec 'autocmd FileType nerdtree syn match ' . a:extension .' #^\s\+.*'. a:extension .'$#'
endfunction
highlight! link NERDTreeFlags NERDTreeDir


" Color
set t_Co=256
syntax on
"set background=dark
set background=light
colorscheme onehalflight

" Allows for mouse scrolling
set mouse=a

" Highlight Current Line
set cursorline
highlight NERDTreeFile ctermfg=14

"我们当前启用的是GUI color，所以cterm的配置并没生效，生效的是gui
hi IncSearch ctermfg=231 ctermbg=71 guifg=#fafafa guibg=#50a14f
hi Search ctermfg=248 ctermbg=71 guifg=#fafafa guibg=#50a14f

nmap <silent> gI 'I
" normal! means nnoremap
autocmd InsertLeave * execute 'normal! mI'

" window 
nnoremap <C-h> <C-w>h
nnoremap <C-j> <C-w>j
nnoremap <C-k> <C-w>k
nnoremap <C-l> <C-w>l
nnoremap <C-p> <C-w><C-p>
" fzf\ctrlp 的列表打开快捷键也是如此，保持一致
nnoremap <silent><C-t> :wincmd T<CR>
nnoremap <silent><C-s> :wincmd s<CR>

" use切换buffer
nnoremap <silent> [b :bprevious<CR>
nnoremap <silent> ]b :bnext<CR>

" 自定义diff主题
hi DiffAdd      gui=none    guifg=NONE          guibg=#bada9f
hi DiffChange   gui=none    guifg=NONE          guibg=#e5d5ac
hi DiffDelete   gui=bold    guifg=#ff8080       guibg=#ffb0b0
hi DiffText     gui=none    guifg=NONE          guibg=#8cbee2

"设置补全源只来自LSP
autocmd FileType go let b:coc_disabled_sources = ['around', 'buffer', 'file']
"autocmd FileType * let b:coc_disabled_sources = ['around', 'buffer', 'file']

"保证S-[ S-]跳转的时候不展开折叠
set foldopen-=block


nnoremap <silent>ss <Plug>(easymotion-s2)


let mapleader=" "
"leader+单字母只保留给最常用的命令,其他一律走命令模式,最大化效率
" let g:ctrlp_map = '<leader>f'
nnoremap <silent> <leader>F  <Plug>(coc-format)
nnoremap <silent> <leader>f :Files <CR>
nnoremap <silent> <leader>h :Ag <CR>
" nnoremap <silent> <leader>s  :<C-u>CocList -I symbols<cr>
" nnoremap <silent> <leader>l  :<C-u>CocList --normal --auto-preview location<cr>
" nnoremap <silent> <leader>q  :CocFix<cr>
" nnoremap <silent> <leader>Q  :copen<cr>
nnoremap <leader>p :<C-u>set paste<cr>
nnoremap <leader>P :<C-u>set nopaste<cr>
map <silent> <leader>n :NvimTreeFindFile<CR>
" map <silent> <leader>n :NERDTreeFind<CR>

" nnoremap <silent><leader>w  :w<CR>



"Copy File Path
nnoremap <silent><leader>cP :let @+ = fnamemodify(resolve(expand("%:p")), ":p")<cr>
"Copy File Path (Relative)
nnoremap <silent><leader>cp :let @+ = fnamemodify(expand("%:p"), ":.")<cr>
"Copy File Name
nnoremap <silent><leader>cn :let @+ = expand("%:t")<cr>
" 转化为垂直/水平分屏
nnoremap <silent> <leader>cv :windo wincmd H<CR>
nnoremap <silent> <leader>cs :windo wincmd K<CR>

nnoremap <silent><leader>gd :Gvdiffsplit<CR>
nnoremap <silent><leader>gb :Git blame<CR>

nnoremap <silent><leader>m :MarkdownPreview<CR>

autocmd FileType markdown nmap <buffer><silent> <leader>i :call mdip#MarkdownClipboardImage()<CR>

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


let g:markdown_fenced_languages = ['html', 'python', 'bash=sh', 'java', 'rust', 'go', 'css', 
            \'javascript', 'js=javascript','c', 'cpp', 'sql', 'json', 'yaml']
" 渲染行数
let g:markdown_minlines = 1000

if has('unix')
 autocmd InsertLeave * :silent !fcitx5-remote -c 
 autocmd BufCreate * :silent !fcitx5-remote -c 
 autocmd BufEnter * :silent !fcitx5-remote -c 
 autocmd BufLeave * :silent !fcitx5-remote -c 
endif

" autocmd BufEnter * lua print('a')

lua require('utils')

lua require('basic')
