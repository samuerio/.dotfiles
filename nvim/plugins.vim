
call plug#begin()

Plug 'ferrine/md-img-paste.vim'

Plug 'windwp/nvim-autopairs'

Plug 'iamcco/markdown-preview.nvim', { 'do': 'cd app && npx --yes yarn install' }

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

Plug 'nvim-telescope/telescope-ui-select.nvim'

Plug 'tpope/vim-fugitive'

Plug 'junegunn/gv.vim'

Plug 'easymotion/vim-easymotion'

Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'

Plug 'freitass/todo.txt-vim'

Plug 'dhruvasagar/vim-table-mode'

Plug 'neoclide/coc.nvim', {'branch': 'release'}

Plug 'nvim-treesitter/nvim-treesitter', {'do': ':TSUpdate'}
Plug 'nvim-treesitter/nvim-treesitter-textobjects'

" One half with treesitter
Plug 'CodeGradox/onehalf-lush'

Plug 'nvim-lua/plenary.nvim'

Plug 'nvim-telescope/telescope-fzf-native.nvim', { 'do': 'make' }

Plug 'nvim-lua/plenary.nvim'

" --- Opencode stuff
Plug 'NickvanDyke/opencode.nvim'
Plug 'folke/snacks.nvim'

" --- Amp IDE integration
Plug 'sourcegraph/amp.nvim'

" Plug 'David-Kunz/gen.nvim'

" Plug 'Exafunction/codeium.vim', { 'branch': 'main' }


call plug#end()

