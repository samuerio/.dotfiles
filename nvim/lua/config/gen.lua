require('gen').setup({
    model = "llama3",    -- The default model to use.
    host = "localhost",  -- The host running the Ollama service.
    port = "11434",      -- The port on which the Ollama service is listening.
    quit_map = "q",      -- set keymap for close the response window
    retry_map = "<c-r>", -- set keymap to re-send the current prompt
    init = function(options) pcall(io.popen, "ollama serve > /dev/null 2>&1 &") end,
    -- Function to initialize Ollama
    command = function(options)
        local body = { model = options.model, stream = true }
        return "curl --silent --no-buffer -X POST http://" ..
            options.host .. ":" .. options.port .. "/api/chat -d $body"
    end,
    -- The command for the Ollama service. You can use placeholders $prompt, $model and $body (shellescaped).
    -- This can also be a command string.
    -- The executed command must return a JSON object with { response, context }
    -- (context property is optional).
    -- list_models = '<omitted lua function>', -- Retrieves a list of model names
    display_mode = "split", -- The display mode. Can be "float" or "split".
    show_prompt = true,     -- Shows the prompt submitted to Ollama.
    show_model = true,      -- Displays which model you are using at the beginning of your chat session.
    no_auto_close = false,  -- Never closes the window automatically.
    debug = false           -- Prints errors and the command which is run.
})

require('gen').prompts['Write_Test'] = {
    prompt =
    'Write a test for the following code. Only output the result in format ```$filetype\n...\n```:```$filetype\n$text\n```',
    replace = false,
}

require('gen').prompts['Write_Comment'] = {
    prompt = 'Write a comment for the following code: $text',
    replace = false,
}



-- require('gen').prompts['Summarize'] = {
--     prompt = "Summarize the following text:\n$text"
-- }

utils.nmap('<leader>z', ':Gen<CR>')
utils.vmap('<leader>z', ':Gen<CR>')
utils.nmap('<leader>g', ':Gen Chat<CR>')
