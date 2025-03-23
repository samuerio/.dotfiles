require('avante_lib').load()
require('avante').setup({
    provider = "openai",
    auto_suggestions_provider = "openai", -- Since auto-suggestions are a high-frequency operation and therefore expensive, it is recommended to specify an inexpensive provider or even a free provider: copilot
    openai = {
        endpoint = "https://api.siliconflow.cn/v1",
        model = "Qwen/Qwen2.5-72B-Instruct",
        -- model = "deepseek-ai/DeepSeek-V3",
        -- endpoint = "https://api.deepseek.com/v1",
        -- model = "deepseek-chat",
        -- model = "deepseek-reasoner",
        -- endpoint = "https://openrouter.ai/api/v1",
        -- model = "qwen/qwen-2.5-coder-32b-instruct",
        -- model = "anthropic/claude-3.5-sonnet",
        -- model = "anthropic/claude-3.5-haiku",
        -- model = "deepseek/deepseek-r1:free",
        -- model = "deepseek/deepseek-chat",
        timeout = 30000, -- Timeout in milliseconds
        temperature = 0,
        max_tokens = 4096,
        -- optional
        api_key_name = "OPENAI_API_KEY", -- default OPENAI_API_KEY if not set
    },
    cursor_applying_provider = 'openrouter',
    behaviour = {
        enable_cursor_planning_mode = true,
    },
    highlights = {
        ---@type AvanteConflictHighlights
        diff = {
            current = "DiffText",
            incoming = "DiffAdd",
        },
    },
    vendors = {
        openrouter = {
            __inherited_from = 'openai',
            api_key_name = 'OPENROUTER_API_KEY',
            endpoint = 'https://openrouter.ai/api/v1',
            -- model = 'qwen-2.5-coder-32b',
            model = 'qwen/qwen-2.5-coder-32b-instruct',
            max_tokens = 8192, -- remember to increase this value, otherwise it will stop generating halfway
        },
    }
})

vim.keymap.set("n", "<leader>ax", ":AvanteClear<CR>", { buffer = buffer, desc = "Avante: Clear Chat History" })
