-- Configuration for 'nvim-treesitter' plugin
--
-- * https://github.com/jeetsukumaran/vim-buffergator
-- * https://github.com/jeetsukumaran/vim-buffergator/blob/master/doc/buffergator.txt

require('nvim-treesitter.configs').setup {
    ensure_installed = {
        "lua",
        "rust",
        "toml",
    },
    auto_install = true,
    -- auto_install = false,
    highlight = {
        enable = true,
        additional_vim_regex_highlighting = false,
    },
    indent = {
        enable = true
    },
}

-- Let treesitter trives the fold method
vim.opt.foldmethod = "expr"
vim.opt.foldexpr = "nvim_treesitter#foldexpr()"
