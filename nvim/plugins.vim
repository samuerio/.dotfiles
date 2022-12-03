
call plug#begin()

Plug 'ferrine/md-img-paste.vim'

Plug 'jiangmiao/auto-pairs'

Plug 'iamcco/markdown-preview.nvim', { 'do': 'cd app && yarn install' }

Plug 'tpope/vim-commentary'

Plug 'airblade/vim-gitgutter'

Plug 'kdheepak/lazygit.nvim'

Plug 'lfv89/vim-interestingwords'

Plug 'tpope/vim-surround'

Plug 'brooth/far.vim'

Plug 'yggdroot/indentline'

Plug 'mhinz/vim-startify'

Plug 'sonph/onehalf', { 'rtp': 'vim' }

Plug 'junegunn/fzf', { 'do': { -> fzf#install() } }
Plug 'junegunn/fzf.vim'

Plug 'scrooloose/nerdtree'

Plug 'nvim-telescope/telescope.nvim'

Plug 'tpope/vim-fugitive'

Plug 'junegunn/gv.vim'

Plug 'easymotion/vim-easymotion'

Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'

Plug 'freitass/todo.txt-vim'

Plug 'dhruvasagar/vim-table-mode'

Plug 'neoclide/coc.nvim', {'branch': 'release'}

call plug#end()

