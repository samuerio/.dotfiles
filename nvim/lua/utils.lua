
-- Command mapping in normal mode with common options.
local function nmap(lhs, rhs)
    local opts = { noremap = true, silent = true }
    vim.api.nvim_set_keymap("n", lhs, rhs, opts)
end

local function imap(lhs, rhs)
    local opts = { noremap = true, silent = true }
    vim.api.nvim_set_keymap("i", lhs, rhs, opts)
end

local function vmap(lhs, rhs)
    local opts = { noremap = true, silent = true }
    vim.api.nvim_set_keymap("v", lhs, rhs, opts)
end

local M = {
    nmap = nmap,
    imap = imap,
    vmap = vmap,
}

-- Export utils to the global table
_G.utils = M

return M
