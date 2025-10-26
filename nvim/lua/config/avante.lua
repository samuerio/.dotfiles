vim.cmd([[set <C-CR>=\e[13;5u]])

require('avante_lib').load()
require('avante').setup({
    -- provider = "aihubmix",
    -- provider = "openai",
    provider = "siliconflow",
    -- provider = "deepseek",
    auto_suggestions_provider = "openai", -- Since auto-suggestions are a high-frequency operation and therefore expensive, it is recommended to specify an inexpensive provider or even a free provider: copilot
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
    providers = {
        openai = {
            -- endpoint = "https://openrouter.ai/api/v1",
            -- model = "qwen/qwen-2.5-coder-32b-instruct",
            -- model = "anthropic/claude-3.5-sonnet",
            -- model = "anthropic/claude-3.5-haiku",
            -- model = "deepseek/deepseek-r1:free",
            -- model = "deepseek/deepseek-chat",
            timeout = 30000, -- Timeout in milliseconds
            extra_request_body = {
                temperature = 0,
            },
            max_tokens = 4096,
            -- optional
            api_key_name = "OPENAI_API_KEY", -- default OPENAI_API_KEY if not set
        },
        aihubmix = {
            model = "DeepSeek-V3",
        },
        openrouter = {
            __inherited_from = 'openai',
            api_key_name = 'OPENROUTER_API_KEY',
            endpoint = 'https://openrouter.ai/api/v1',
            -- model = 'qwen-2.5-coder-32b',
            model = 'qwen/qwen-2.5-coder-32b-instruct',
            max_tokens = 8192, -- remember to increase this value, otherwise it will stop generating halfway
        },
        deepseek = {
            __inherited_from = "openai",
            api_key_name = "DEEPSEEK_API_KEY",
            endpoint = "https://api.deepseek.com/v1",
            model = "deepseek-chat",
            -- model = "deepseek-reasoner",
        },
        siliconflow = {
            __inherited_from = "openai",
            api_key_name = "SILICONFLOW_API_KEY",
            endpoint = "https://api.siliconflow.cn/v1",
            -- model = "Qwen/Qwen2.5-72B-Instruct",
            model = "deepseek-ai/DeepSeek-V3",
        },
    },

    mappings = {
        submit = {
            insert = "<C-CR>",
        },
    }
    -- rag_service = {
    --     enabled = false,                        -- Enables the RAG service
    --     host_mount = os.getenv("HOME"),         -- Host mount path for the rag service
    --     provider = "openai",                    -- The provider to use for RAG service (e.g. openai or ollama)
    --     llm_model = "DeepSeek-V3",              -- The LLM model to use for RAG service
    --     embed_model = "text-embedding-3-small", -- The embedding model to use for RAG service
    --     endpoint = "https://aihubmix.com/v1",   -- The API endpoint for RAG service
    --     runner = "docker"                       -- "docker" or "nix"
    -- },
})

vim.keymap.set("n", "<leader>ax", ":AvanteClear<CR>", { buffer = buffer, desc = "Avante: Clear Chat History" })
