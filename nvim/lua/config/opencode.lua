require('snacks').setup({
    input = { enabled = true },
    picker = { enabled = true },
    terminal = { enabled = true }
})

local opencode = require('opencode')

-- Required for `opts.auto_reload`
vim.opt.autoread = true

-- Recommended/example keymaps
vim.keymap.set({ 'n', 'x' }, '<leader>oo', function() opencode.ask('@this: ', { submit = true }) end,
    { desc = 'Ask opencode…"' })
vim.keymap.set({ 'n', 'x' }, '<leader>oa', function() opencode.select() end, { desc = 'Execute opencode action…' })
vim.keymap.set('n', '<leader>ot', function() opencode.toggle() end, { desc = 'Toggle opencode' })

vim.keymap.set('n', '<leader>o+', function() opencode.prompt('@buffer', { append = true }) end,
    { desc = 'Add buffer to prompt' })

vim.keymap.set({ "n", "x" }, "go", function() return require("opencode").operator("@this ") end,
    { desc = "Add range to opencode", expr = true })
vim.keymap.set("n", "goo", function() return require("opencode").operator("@this ") .. "_" end,
    { desc = "Add line to opencode", expr = true })

vim.keymap.set('n', '<S-C-u>', function() opencode.command('messages_half_page_up') end,
    { desc = 'Scroll opencode up' })
vim.keymap.set('n', '<S-C-d>', function() opencode.command('messages_half_page_down') end,
    { desc = 'Scroll opencode down' })

vim.g.opencode_opts = {
    provider = {
        enabled = 'tmux',
        tmux = {
            options = '-h -p 35'
        }
    }
}
