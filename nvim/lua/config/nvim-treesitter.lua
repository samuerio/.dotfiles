-- Configuration for 'nvim-treesitter' plugin

local treesitter = require('nvim-treesitter')

treesitter.setup()

if vim.fn.executable('tree-sitter') == 1 then
    treesitter.install({
        'lua',
        'rust',
        'toml',
        'markdown',
        'markdown_inline',
        'bash',
        'python',
        'java',
        'go',
        'javascript',
        'c',
        'cpp',
        'json',
        'yaml',
        'html',
        'css',
        'vim',
        'vimdoc',
    })
end

vim.api.nvim_create_autocmd('FileType', {
    callback = function(args)
        if not pcall(vim.treesitter.start, args.buf) then
            return
        end

        vim.wo.foldmethod = 'expr'
        vim.wo.foldexpr = 'v:lua.vim.treesitter.foldexpr()'
        vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
    end,
})

require('nvim-treesitter-textobjects').setup {
    select = {
        enable = true,
        lookahead = true,
        selection_modes = {
            ['@parameter.outer'] = 'v',
        },
        include_surrounding_whitespace = true,
    },
}

local select = require('nvim-treesitter-textobjects.select')

vim.keymap.set({ 'x', 'o' }, 'af', function()
    select.select_textobject('@function.outer', 'textobjects')
end, { desc = 'Select outer function' })

vim.keymap.set({ 'x', 'o' }, 'if', function()
    select.select_textobject('@function.inner', 'textobjects')
end, { desc = 'Select inner function' })

vim.keymap.set({ 'x', 'o' }, 'ac', function()
    select.select_textobject('@class.outer', 'textobjects')
end, { desc = 'Select outer class' })

vim.keymap.set({ 'x', 'o' }, 'ic', function()
    select.select_textobject('@class.inner', 'textobjects')
end, { desc = 'Select inner class' })

vim.keymap.set({ 'x', 'o' }, 'as', function()
    select.select_textobject('@local.scope', 'locals')
end, { desc = 'Select language scope' })
