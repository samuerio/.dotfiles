require('avante_lib').load()
require('avante').setup({
    provider = "openai",
    auto_suggestions_provider = "openai", -- Since auto-suggestions are a high-frequency operation and therefore expensive, it is recommended to specify an inexpensive provider or even a free provider: copilot
    openai = {
        -- endpoint = "https://api.deepseek.com/v1",
        -- model = "deepseek-chat",
        -- model = "deepseek-reasoner",
        endpoint = "https://openrouter.ai/api/v1",
        model = "qwen/qwen-2.5-coder-32b-instruct",
        -- model = "anthropic/claude-3.5-sonnet",
        -- model = "deepseek/deepseek-r1:free",
        timeout = 30000, -- Timeout in milliseconds
        temperature = 0,
        max_tokens = 4096,
        -- optional
        api_key_name = "OPENAI_API_KEY", -- default OPENAI_API_KEY if not set
    },
    highlights = {
        ---@type AvanteConflictHighlights
        diff = {
            current = "DiffText",
            incoming = "DiffAdd",
        },
    },
})

vim.api.nvim_set_keymap(
    "n",
    "<leader>g",
    ":AvanteAsk ",
    { noremap = true, silent = false }
)
