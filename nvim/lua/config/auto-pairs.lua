vim.api.nvim_create_autocmd(
    { "Filetype" },
    { pattern = "markdown", command = "let b:autopairs_enabled = 0" }
)
vim.api.nvim_create_autocmd(
    { "Filetype" },
    { pattern = "markdown", command = "let b:AutoPairs={'(':')', '[':']', '{':'}','\"':'\"', '`':'`'}" }
)
