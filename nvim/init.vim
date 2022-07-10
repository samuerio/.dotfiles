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
set colorcolumn=80
set signcolumn=yes
set cmdheight=2
set updatetime=300
" Don't pass messages to |ins-completion-menu|.
set shortmess+=c
set rtp+=/opt/homebrew/opt/fzf
set nrformats=
set concealcursor=
set conceallevel=2


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

Plug 'nvim-telescope/telescope.nvim'

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
Plug 'neoclide/coc.nvim', {'branch': 'release'}
" Use tab for trigger completion with characters ahead and navigate.
" Use command ':verbose imap <tab>' to make sure tab is not mapped by other plugin.
" inoremap <silent><expr> <TAB>
"       \ pumvisible() ? "\<C-n>" :
"       \ <SID>check_back_space() ? "\<TAB>" :
"       \ coc#refresh()
" inoremap <expr><S-TAB> pumvisible() ? "\<C-p>" : "\<C-h>"

function! s:check_back_space() abort
  let col = col('.') - 1
  return !col || getline('.')[col - 1]  =~# '\s'
endfunction

" Possible bug with guicursor option on your terminal, you can disable transparent cursor
let g:coc_disable_transparent_cursor = 1

inoremap <C-n>  <Nop>
" inoremap <silent><expr> <C-n> coc#refresh()
" inoremap <silent><expr> <C-j> coc#refresh()

function! s:wildchar()
    call feedkeys("\<Tab>", 'nt')
    return ''
endfunction

let g:coc_snippet_next="<C-n>"
let g:coc_snippet_prev="<C-p>"			

"统一使用C-j/C-k进行下拉框的选择,C-n\C-p这种方向键只是对输入历史的选择
"Use <C-j> and <C-k> to navigate the completion list:
"智能补全下的搜索是模糊大小写的，非常方便
inoremap <expr> <C-j> pumvisible() ? "\<C-n>" : coc#refresh()
inoremap <expr> <C-k> pumvisible() ? "\<C-p>" : "\<C-k>"
cnoremap <expr> <C-j> pumvisible() ? "\<C-n>" : "\<C-r>=<SID>wildchar()<CR>"
cnoremap <expr> <C-k> pumvisible() ? "\<C-p>" : "\<C-k>"

" Make <CR> auto-select the first completion item and notify coc.nvim to
" format on enter, <cr> could be remapped by other vim plugin
inoremap <silent><expr> <cr> pumvisible() ? coc#_select_confirm()
                              \: "\<C-g>u\<CR>\<c-r>=coc#on_enter()\<CR>"

" Use `[d` and `]d` to navigate diagnostics
nmap <silent> [d <Plug>(coc-diagnostic-prev)
nmap <silent> ]d <Plug>(coc-diagnostic-next)

" Use `[c' and ']' to navigate locations`
nnoremap <silent><nowait>[c :<C-u>CocPrev<CR>
nnoremap <silent><nowait>]c :<C-u>CocNext<CR>

" Remap keys for gotos
" 这里就是tabe，tabe是tabe[edit]的缩写
nmap <silent> gt :call CocActionAsync('jumpDefinition', 'tabe')<CR>
nmap <silent> gd <Plug>(coc-definition)
nmap <silent> gy <Plug>(coc-type-definition)
nmap <silent> gi <Plug>(coc-implementation)
nmap <silent> gr <Plug>(coc-references)
" Use K to show documentation in preview window
nnoremap <silent> K :call <SID>show_documentation()<CR>

function! s:show_documentation()
  if (index(['vim','help'], &filetype) >= 0)
    execute 'h '.expand('<cword>')
  else
    call CocAction('doHover')
  endif
endfunction
if has('nvim-0.4.0') || has('patch-8.2.0750')
    nnoremap <silent><nowait><expr> <C-f> coc#float#has_scroll() ? coc#float#scroll(1) : "\<C-f>"
    nnoremap <silent><nowait><expr> <C-b> coc#float#has_scroll() ? coc#float#scroll(0) : "\<C-b>"
    inoremap <silent><nowait><expr> <C-f> coc#float#has_scroll() ? "\<c-r>=coc#float#scroll(1)\<cr>" : "\<Right>"
    inoremap <silent><nowait><expr> <C-b> coc#float#has_scroll() ? "\<c-r>=coc#float#scroll(0)\<cr>" : "\<Left>"
    vnoremap <silent><nowait><expr> <C-f> coc#float#has_scroll() ? coc#float#scroll(1) : "\<C-f>"
    vnoremap <silent><nowait><expr> <C-b> coc#float#has_scroll() ? coc#float#scroll(0) : "\<C-b>"
endif

" Highlight symbol under cursor on CursorHold,有时候会失效,还是手动高亮吧
autocmd CursorHold * silent call CocActionAsync('highlight')

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
" " AutoCompleteRelated
Plug 'neoclide/coc.nvim', {'branch': 'release'}


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
"修复outline搜索的时候
"CocTreeSelected的优先级高于CocCursorRange的优先级从而导致搜索关键字在选中行不显示的问题(搜索关键字的字体颜色是白色背景是绿色,
"被选中行的背景灰色覆盖了绿色,最后只剩下了白色字体\灰色背景,就出现了搜索关键字不显示的问题)
hi CocTreeSelected ctermfg=248 ctermbg=71 guifg=#fafafa guibg=#50a14f
" hi CocTreeSelected ctermbg=255 guibg=#f0f0f0
" hi! link CocCursorRange Search

"highlight Normal guibg=none

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
nnoremap <silent> <leader>o  :<C-u>CocList outline<cr>
nnoremap <silent> <leader>s  :<C-u>CocList -I symbols<cr>
nnoremap <silent> <leader>d  :<C-u>CocList diagnostics<cr>
nnoremap <silent> <leader>l  :<C-u>CocList --normal --auto-preview location<cr>
nnoremap <silent> <leader>r  <Plug>(coc-rename)
nnoremap <silent> <leader>q  :CocFix<cr>
nnoremap <silent> <leader>Q  :copen<cr>
nnoremap <leader>p :<C-u>set paste<cr>
nnoremap <leader>P :<C-u>set nopaste<cr>
map <silent> <leader>n :NERDTreeFind<CR>
nnoremap <silent><leader>x :wincmd c<CR>
nnoremap <silent><leader>w  :w<cr>


nnoremap <silent><leader>j :call ToggleOutline()<CR>
function! ToggleOutline() abort
  let winid = coc#window#find('cocViewId', 'OUTLINE')
  if winid == -1
    call CocActionAsync('showOutline', 1)
  else
    call coc#window#close(winid)
  endif
endfunction

"Copy File Path
nnoremap <silent><leader>cp :let @+ = expand("%")<cr>
" 转化为垂直/水平分屏
nnoremap <silent> <leader>cv :windo wincmd H<CR>
nnoremap <silent> <leader>cs :windo wincmd K<CR>

nnoremap <silent><leader>gd :Gvdiffsplit<CR>
nnoremap <silent><leader>gb :Git blame<CR>
nnoremap <silent><leader>gi gi

nnoremap <silent><leader>m :MarkdownPreview<CR>

autocmd FileType markdown nmap <buffer><silent> <leader>i :call mdip#MarkdownClipboardImage()<CR>


let g:markdown_fenced_languages = ['html', 'python', 'bash=sh', 'java', 'rust', 'go', 'css', 
            \'javascript', 'js=javascript','c', 'cpp', 'sql', 'json', 'yaml']
" 渲染行数
let g:markdown_minlines = 1000

