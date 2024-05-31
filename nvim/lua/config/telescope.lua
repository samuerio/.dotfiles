-- telescope.nvim
local fzf_opts = {
    fuzzy = true, -- false will only do exact matching
    override_generic_sorter = true, -- override the generic sorter
    override_file_sorter = true, -- override the file sorter
    case_mode = "smart_case", -- or "ignore_case" or "respect_case"
    -- the default case_mode is "smart_case"
}

local builtin = require('telescope.builtin')
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
        ["ui-select"] = {
            require("telescope.themes").get_dropdown {
                -- even more opts
            }

            -- pseudo code / specification for writing custom displays, like the one
            -- for "codeactions"
            -- specific_opts = {
            --   [kind] = {
            --     make_indexed = function(items) -> indexed_items, width,
            --     make_displayer = function(widths) -> displayer
            --     make_display = function(displayer) -> function(e)
            --     make_ordinal = function(e) -> string
            --   },
            --   -- for example to disable the custom builtin "codeactions" display
            --      do the following
            --   codeactions = false,
            -- }
        },
    }
}

telescope.load_extension('fzf')
telescope.load_extension('ui-select')


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

-- vim.keymap.set('n', '<leader>o', showDocumentSymbols, {})
vim.keymap.set('n', '<leader>t', builtin.treesitter, {})
-- vim.keymap.set('n', '<leader>s', showWorkspaceSymbols, {})
