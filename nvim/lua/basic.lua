-- Mappings.
-- See `:help vim.diagnostic.*` for documentation on any of the below functions
local opts = { noremap = true, silent = true }
vim.keymap.set('n', '<leader>e', vim.diagnostic.open_float, opts)
vim.keymap.set('n', '[d', vim.diagnostic.goto_prev, opts)
vim.keymap.set('n', ']d', vim.diagnostic.goto_next, opts)
vim.keymap.set('n', '<leader>d', vim.diagnostic.setloclist, opts)

local function lsp_highlight_document(client)
    if client.supports_method('textDocument/documentHighlight') then
        vim.api.nvim_exec([[
            hi LspReferenceRead cterm=bold ctermbg=red guibg=#D5D5D5
            hi LspReferenceText cterm=bold ctermbg=red guibg=#D5D5D5
            hi LspReferenceWrite cterm=bold ctermbg=red guibg=#D5D5D5
            augroup lsp_document_highlight
                autocmd! * <buffer>
                autocmd CursorHold <buffer> lua vim.lsp.buf.document_highlight()
                autocmd CursorMoved <buffer> lua vim.lsp.buf.clear_references()
            augroup END
            ]],
            false)
    end
end

-- Use an on_attach function to only map the following keys
-- after the language server attaches to the current buffer
local on_attach = function(client, bufnr)

    lsp_highlight_document(client)

    -- Enable completion triggered by <c-x><c-o>
    vim.api.nvim_buf_set_option(bufnr, 'omnifunc', 'v:lua.vim.lsp.omnifunc')

    local bufopts = { noremap = true, silent = true, buffer = bufnr }
    vim.keymap.set('n', 'K', vim.lsp.buf.hover, bufopts)
    vim.keymap.set('n', 'gd', vim.lsp.buf.definition, bufopts)
    -- vim.keymap.set('n', 'gd', vim.lsp.buf.declaration, bufopts)
    vim.keymap.set('n', 'gy', vim.lsp.buf.type_definition, bufopts)
    vim.keymap.set('n', 'gi', vim.lsp.buf.implementation, bufopts)
    vim.keymap.set('n', 'gr', vim.lsp.buf.references, bufopts)

    vim.keymap.set('n', '<leader>r', vim.lsp.buf.rename, bufopts)

    -- 会影响null_ls接受FORMATING请求
    -- if client.server_capabilities.document_formatting then
    --     vim.keymap.set('n', '<leader>F', function() vim.lsp.buf.format { async = true } end, bufopts)
    -- end
    vim.keymap.set('n', '<leader>F', function() vim.lsp.buf.format { async = true } end, bufopts)

    if client.supports_method("textDocument/formatting") then
        vim.api.nvim_clear_autocmds({ group = augroup, buffer = bufnr })
        vim.api.nvim_create_autocmd("BufWritePre", {
            group = augroup,
            buffer = bufnr,
            callback = function()
                -- on 0.8, you should use vim.lsp.buf.format({ bufnr = bufnr }) instead
                -- vim.lsp.buf.formatting_sync()
                vim.lsp.buf.format({ bufnr = bufnr })
            end,
        })
    end

    -- symbols-outline.nvim
    utils.nmap("<leader>j", ":SymbolsOutline<CR>")
    require("symbols-outline").setup({
        highlight_hovered_item = true,
        show_guides = true,
        auto_preview = false,
        position = 'right',
        relative_width = false,
        width = 30,
        auto_close = false,
        show_numbers = false,
        show_relative_numbers = false,
        show_symbol_details = true,
        preview_bg_highlight = 'Pmenu',
        autofold_depth = nil,
        auto_unfold_hover = true,
        fold_markers = { '', '' },
        wrap = false,
        keymaps = { -- These keymaps can be a string or a table for multiple keys
            close = { "<Esc>", "q" },
            goto_location = "<Cr>",
            focus_location = "o",
            hover_symbol = "K",
            toggle_preview = "<F1>",
            rename_symbol = "r",
            code_actions = "a",
            fold = "h",
            unfold = "l",
            fold_all = "W",
            unfold_all = "E",
            fold_reset = "R",
        },
        lsp_blacklist = {},
        symbol_blacklist = { 'Variable' },
        symbols = {
            File = { icon = "", hl = "TSURI" },
            Module = { icon = "", hl = "TSNamespace" },
            Namespace = { icon = "", hl = "TSNamespace" },
            Package = { icon = "", hl = "TSNamespace" },
            Class = { icon = "𝓒", hl = "TSType" },
            Method = { icon = "ƒ", hl = "TSMethod" },
            Property = { icon = "", hl = "TSMethod" },
            Field = { icon = "", hl = "TSField" },
            Constructor = { icon = "", hl = "TSConstructor" },
            Enum = { icon = "ℰ", hl = "TSType" },
            Interface = { icon = "ﰮ", hl = "TSType" },
            Function = { icon = "", hl = "TSFunction" },
            Variable = { icon = "", hl = "TSConstant" },
            Constant = { icon = "", hl = "TSConstant" },
            String = { icon = "𝓐", hl = "TSString" },
            Number = { icon = "#", hl = "TSNumber" },
            Boolean = { icon = "⊨", hl = "TSBoolean" },
            Array = { icon = "", hl = "TSConstant" },
            Object = { icon = "⦿", hl = "TSType" },
            Key = { icon = "🔐", hl = "TSType" },
            Null = { icon = "NULL", hl = "TSType" },
            EnumMember = { icon = "", hl = "TSField" },
            Struct = { icon = "𝓢", hl = "TSType" },
            Event = { icon = "🗲", hl = "TSType" },
            Operator = { icon = "+", hl = "TSOperator" },
            TypeParameter = { icon = "𝙏", hl = "TSParameter" }
        }
    })
end

-- Add additional capabilities supported by nvim-cmp
local capabilities = require('cmp_nvim_lsp').default_capabilities()

local lspconfig = require('lspconfig')
local lsp_flags = {
    -- This is the default in Nvim 0.7+
    debounce_text_changes = 150,
}

-- python
require 'lspconfig'.pyright.setup {
    on_attach = on_attach,
    flags = lsp_flags
}

-- vim.lsp.set_log_level("debug")
-- solidity
require 'lspconfig'.solc.setup {
    on_attach = on_attach,
    --注意:这里不能使用solc-select安装的solc, 否则无法启动lsp模式
    cmd = { "/Users/zhenghe/source/github/.dotfiles/solc-macos", "--lsp" },
    flags = lsp_flags,
    settings = {
        ["file-load-strategy"] = "directly-opened-and-on-import",
    },
    -- capabilities = capabilities ,
    -- root_dir = lspconfig.util.root_pattern('hardhat.config.*', '.git'),
}

-- lua
require 'lspconfig'.sumneko_lua.setup {
    on_attach = on_attach,
    flags = lsp_flags,
    settings = {
        Lua = {
            runtime = {
                -- Tell the language server which version of Lua you're using (most likely LuaJIT in the case of Neovim)
                version = 'LuaJIT',
            },
            diagnostics = {
                -- Get the language server to recognize the `vim` global
                globals = { 'vim' },
            },
            workspace = {
                -- Make the server aware of Neovim runtime files
                library = vim.api.nvim_get_runtime_file("", true),
            },
            -- Do not send telemetry data containing a randomized but unique identifier
            telemetry = {
                enable = false,
            },
        },
    },
}

-- JSON lsp
lspconfig.jsonls.setup({
    on_attach = on_attach,
    settings = {
        json = {
            -- Schemas https://www.schemastore.org
            schemas = {
                {
                    fileMatch = { 'package.json' },
                    url = 'https://json.schemastore.org/package.json',
                },
                {
                    fileMatch = { 'tsconfig*.json' },
                    url = 'https://json.schemastore.org/tsconfig.json',
                },
                {
                    fileMatch = {
                        '.prettierrc',
                        '.prettierrc.json',
                        'prettier.config.json',
                    },
                    url = 'https://json.schemastore.org/prettierrc.json',
                },
                {
                    fileMatch = { '.eslintrc', '.eslintrc.json' },
                    url = 'https://json.schemastore.org/eslintrc.json',
                },
                {
                    fileMatch = {
                        '.babelrc',
                        '.babelrc.json',
                        'babel.config.json',
                    },
                    url = 'https://json.schemastore.org/babelrc.json',
                },
                {
                    fileMatch = { 'lerna.json' },
                    url = 'https://json.schemastore.org/lerna.json',
                },
                {
                    fileMatch = { 'now.json', 'vercel.json' },
                    url = 'https://json.schemastore.org/now.json',
                },
                {
                    fileMatch = {
                        '.stylelintrc',
                        '.stylelintrc.json',
                        'stylelint.config.json',
                    },
                    url = 'http://json.schemastore.org/stylelintrc.json',
                },
            },
        },
    },
    capabilities = capabilities,
})

-- golang
require 'lspconfig'.gopls.setup {
    on_attach = on_attach,
    flags = lsp_flags
}

local null_ls = require("null-ls")
null_ls.setup({
    on_attach = on_attach,
    sources = {
        -- Python formatting
        null_ls.builtins.formatting.autopep8,
    },
})


-- telescope.nvim
local fzf_opts = {
    fuzzy = true, -- false will only do exact matching
    override_generic_sorter = true, -- override the generic sorter
    override_file_sorter = true, -- override the file sorter
    case_mode = "smart_case", -- or "ignore_case" or "respect_case"
    -- the default case_mode is "smart_case"
}

local actions = require('telescope.actions')
local telescope = require "telescope"
telescope.setup {
    defaults = {
        -- 查看workspace symbols结果的时候,不要出来文件路径
        theme = 'dropdown',
        layout_strategy = 'bottom_pane',
        layout_config = {
            height = 12,
            prompt_position = 'bottom'
        },
        path_display = { "hidden" },
        -- Default configuration for telescope goes here:
        -- config_key = value,
        file_ignore_patterns = { 'node_modules ' },
        mappings = {
            i = {
                -- map actions.which_key to <C-h> (default: <C-/>)
                -- actions.which_key shows the mappings for your picker,
                -- e.g. git_{create, delete, ...}_branch for the git_branches picker
                ["?"] = "which_key",
                ["<C-j>"] = actions.move_selection_next,
                ["<C-k>"] = actions.move_selection_previous,
                ["<C-n>"] = require("telescope.actions").cycle_history_next,
                ["<C-p>"] = require("telescope.actions").cycle_history_prev,
                ["<C-s>"] = actions.file_split,
                ["<C-v>"] = actions.file_vsplit,
            },
            n = {
            }
        }
    },
    pickers = {
        -- Default configuration for builtin pickers goes here:
        -- picker_name = {
        --   picker_config_key = value,
        --   ...
        -- }
        -- Now the picker_config_key will be applied every time you call this
        lsp_document_symbols = {
            -- initial_mode = 'normal',
            symbol_width = 48,
            prompt_title = '',
            results_title = '',
            prompt_prefix = " symbols: ",
        },
        lsp_dynamic_workspace_symbols = {
            sorter = telescope.extensions.fzf.native_fzf_sorter(fzf_opts),
            symbol_width = 48,
            prompt_title = '',
            results_title = '',
            prompt_prefix = " workspace symbols: ",
        }, -- builtin picker
    },
    extensions = {
        -- Your extension configuration goes here:
        -- extension_name = {
        --   extension_config_key = value,
        -- }
        -- please take a look at the readme of the extension you want to configure
        fzf = fzf_opts,
    }
}

telescope.load_extension('fzf')

local builtin = require('telescope.builtin')

local showWorkspaceSymbols = function()
    local opts = {
        ignore_symbols = {
            "variable",
        },
        symbol_width = 48,
        -- previewer = false,
        -- show_line = true,
    }
    builtin.lsp_dynamic_workspace_symbols(opts)
end

local showDocumentSymbols = function()
    local opts = {
        ignore_symbols = {
            "variable",
        },
    }
    builtin.lsp_document_symbols(opts)
end

vim.keymap.set('n', '<leader>o', showDocumentSymbols, {})
-- vim.keymap.set('n', '<leader>o', builtin.treesitter, {})
vim.keymap.set('n', '<leader>s', showWorkspaceSymbols, {})


-- Set up nvim-cmp.
local cmp = require 'cmp'

local complete_or_next = function()
    if cmp.visible() then
        cmp.select_next_item()
    else
        cmp.complete()
    end
end

cmp.setup({
    completion = {
        autocomplete = false,
    },
    snippet = {
        -- REQUIRED - you must specify a snippet engine
        expand = function(args)
            vim.fn["vsnip#anonymous"](args.body) -- For `vsnip` users.
            -- require('luasnip').lsp_expand(args.body) -- For `luasnip` users.
            -- require('snippy').expand_snippet(args.body) -- For `snippy` users.
            -- vim.fn["UltiSnips#Anon"](args.body) -- For `ultisnips` users.
        end,
    },
    window = {
        -- completion = cmp.config.window.bordered(),
        -- documentation = cmp.config.window.bordered(),
    },
    mapping = cmp.mapping.preset.insert({
        ['<C-j>'] = cmp.mapping(complete_or_next),
        ['<C-k>'] = cmp.mapping.select_prev_item(),
        ['<C-u>'] = cmp.mapping.scroll_docs(-4),
        ['<C-d>'] = cmp.mapping.scroll_docs(4),
        ['<ESC>'] = cmp.mapping.abort(),
        ['<CR>'] = cmp.mapping.confirm({
            select = true,
            behavior = cmp.ConfirmBehavior.Replace
        }), -- Accept currently selected item. Set `select` to `false` to only confirm explicitly selected items.
    }),
    sources = cmp.config.sources({
        { name = 'nvim_lsp' },
        { name = 'vsnip' }, -- For vsnip users.
        -- { name = 'luasnip' }, -- For luasnip users.
        -- { name = 'ultisnips' }, -- For ultisnips users.
        -- { name = 'snippy' }, -- For snippy users.
        { name = 'nvim_lsp_signature_help' },
    }, {
        { name = 'buffer' },
    })
})

-- Use buffer source for `/` and `?` (if you enabled `native_menu`, this won't work anymore).
cmp.setup.cmdline({ '/', '?' }, {
    mapping = cmp.mapping.preset.cmdline(),
    sources = {
        { name = 'buffer' }
    }
})

-- Use cmdline & path source for ':' (if you enabled `native_menu`, this won't work anymore).
cmp.setup.cmdline(':', {
    mapping = cmp.mapping.preset.cmdline(),
    sources = cmp.config.sources({
        { name = 'path' }
    }, {
        { name = 'cmdline' }
    })
})

--nvim-tree
-- disable netrw at the very start of your init.lua (strongly advised)
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

-- set termguicolors to enable highlight groups
vim.opt.termguicolors = true

-- empty setup using defaults
require("nvim-tree").setup()

-- OR setup with some options

require("nvim-tree").setup({
    sort_by = "case_sensitive",
    view = {
        adaptive_size = true,
        mappings = {
            list = {
                { key = "u", action = "dir_up" },
                { key = 'o', action = "edit" },
                { key = '<C-e>', action = "" },
            },
        },
    },
    renderer = {
        group_empty = true,
    },
    filters = {
        dotfiles = true,
    },
    respect_buf_cwd = true,
    update_cwd = true,
    update_focused_file = {
        enable = true,
        update_cwd = true
    },
})
