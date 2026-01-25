vim.g.coc_disable_transparent_cursor = 1

vim.g.coc_snippet_next = "<tab>"
vim.g.coc_snippet_prev = "<s-tab>"

local keyset = vim.keymap.set
function _G.check_back_space()
    local col = vim.fn.col('.') - 1
    return col == 0 or vim.fn.getline('.'):sub(col, col):match('%s') ~= nil
end

--utils.imap('<C-n>', '<Nop>')

local opts = { silent = true, noremap = true, expr = true, replace_keycodes = false }
keyset("i", "<C-j>", 'coc#pum#visible() ? coc#pum#next(1) : coc#refresh()', opts)
keyset("i", "<C-k>", [[coc#pum#visible() ? coc#pum#prev(1) : "\<C-k>"]], opts)
-- 备用选择键
keyset("i", "<C-n>", 'coc#pum#visible() ? coc#pum#next(1) : "<C-n>"', opts)
keyset("i", "<C-p>", 'coc#pum#visible() ? coc#pum#prev(1) : "<C-p>"', opts)

-- keyset("i", "<cr>", [[coc#pum#visible() ? coc#pum#confirm() : "\<C-g>u\<CR>\<c-r>=coc#on_enter()\<CR>"]], opts)
keyset("i", "<cr>", [[coc#pum#visible() ? coc#pum#confirm() : "\<Enter>"]], opts)

keyset("n", "[d", "<Plug>(coc-diagnostic-prev)", { silent = true })
keyset("n", "]d", "<Plug>(coc-diagnostic-next)", { silent = true })

utils.nmap('[c', ':<C-u>CocPrev<CR>')
utils.nmap(']c', ':<C-u>CocNext<CR>')

vim.cmd([[
    nmap <silent> gt :call CocActionAsync('jumpTypeDefinition', 'tabe')<CR>
]])
keyset("n", "gd", "<Plug>(coc-definition)", { silent = true })
keyset("n", "gy", "<Plug>(coc-type-definition)", { silent = true })
keyset("n", "gi", "<Plug>(coc-implementation)", { silent = true })
keyset("n", "gr", "<Plug>(coc-references)", { silent = true })

function _G.show_docs()
    local cw = vim.fn.expand('<cword>')
    if vim.fn.index({ 'vim', 'help' }, vim.bo.filetype) >= 0 then
        vim.api.nvim_command('h ' .. cw)
    elseif vim.api.nvim_eval('coc#rpc#ready()') then
        vim.fn.CocActionAsync('doHover')
    else
        vim.api.nvim_command('!' .. vim.o.keywordprg .. ' ' .. cw)
    end
end

keyset("n", "K", '<CMD>lua _G.show_docs()<CR>', { silent = true })

-- Remap <C-f> and <C-b> for scroll float windows/popups.
---@diagnostic disable-next-line: redefined-local
local opts = { silent = true, nowait = true, expr = true }
keyset("n", "<C-f>", 'coc#float#has_scroll() ? coc#float#scroll(1) : "<C-f>"', opts)
keyset("n", "<C-b>", 'coc#float#has_scroll() ? coc#float#scroll(0) : "<C-b>"', opts)
keyset("i", "<C-f>",
    'coc#float#has_scroll() ? "<c-r>=coc#float#scroll(1)<cr>" : "<Right>"', opts)
keyset("i", "<C-b>",
    'coc#float#has_scroll() ? "<c-r>=coc#float#scroll(0)<cr>" : "<Left>"', opts)
keyset("v", "<C-f>", 'coc#float#has_scroll() ? coc#float#scroll(1) : "<C-f>"', opts)
keyset("v", "<C-b>", 'coc#float#has_scroll() ? coc#float#scroll(0) : "<C-b>"', opts)

-- Highlight the symbol and its references when holding the cursor.
vim.api.nvim_create_augroup("CocGroup", {})
vim.api.nvim_create_autocmd("CursorHold", {
    group = "CocGroup",
    command = "silent call CocActionAsync('highlight')",
    desc = "Highlight symbol under cursor on CursorHold"
})

vim.cmd([[
    highlight! link CocMenuSel PmenuSel
    hi CocListLine  ctermfg=248 ctermbg=71 guifg=#fafafa guibg=#50a14f
]])

-- vim.api.nvim_create_autocmd(
--     { "FileType" },
--     { pattern = "go", command = "let b:coc_disabled_sources = ['around', 'buffer', 'file']" }
-- )

utils.nmap('<leader>F', '<Plug>(coc-format)')
utils.nmap('<leader>o', ':<C-u>CocList outline<cr>')
utils.nmap('<leader>j', ':<C-u>CocOutline<cr>')
utils.nmap('<leader>s', ':<C-u>CocList -I symbols<cr>')
utils.nmap('<leader>d', ':<C-u>CocList diagnostics<cr>')
utils.nmap('<leader>l', ':<C-u>:CocListResume<cr>')
utils.nmap('<leader>r', '<Plug>(coc-rename)')
-- quickfix
utils.nmap('<leader>q', ':CocFix<cr>')
-- code actions
utils.nmap('<leader>a', ':CocAction<cr>')
utils.nmap('<leader>Q', ':copen<cr>')

vim.cmd([[
	command! -nargs=* -range CocFix    :call CocActionAsync('codeActionRange', <line1>, <line2>, 'quickfix')
	command! -nargs=* -range CocAction :call CocActionAsync('codeActionRange', <line1>, <line2>, <f-args>)
]])


-- :CocInstall coc-yank
utils.nmap('<leader>y', ':<C-u>CocList -A --normal yank<cr>')
