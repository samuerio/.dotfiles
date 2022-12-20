vim.g.mdip_imgdir_absolute = '/Users/zhenghe/Dropbox/img'
vim.api.nvim_create_autocmd(
    { "FileType" },
    { pattern = "markdown", command = "nmap <buffer><silent> <leader>i :call mdip#MarkdownClipboardImage()<CR>" }
)
