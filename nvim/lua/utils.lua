
-- Command mapping in normal mode with common options.
local function nmap(lhs, rhs)
    local opts = { noremap = true, silent = true }
    vim.api.nvim_set_keymap("n", lhs, rhs, opts)
end

local M = {
    nmap = nmap,
}

-- Export utils to the global table
_G.utils = M

return M
