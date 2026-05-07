local pane_id = vim.g.opencode_tmux_pane_id
local server_start
local server_stop
local server_toggle

vim.g.opencode_opts = {
  server = {
    start = function() return server_start() end,
    stop = function() return server_stop() end,
    toggle = function() return server_toggle() end,
  },
}

local pane_owner = tostring(vim.fn.getpid())
local pane_owner_option = '@opencode_nvim_owner'

local function tmux(args)
  local command = { 'tmux' }
  vim.list_extend(command, args)

  local ok, result = pcall(vim.fn.system, command)
  if not ok or vim.v.shell_error ~= 0 then
    return nil
  end
  return result
end

local function set_pane_id(id)
  if id == '' then
    id = nil
  end
  pane_id = id
  vim.g.opencode_tmux_pane_id = id
end

local function tmux_pane_exists(id)
  if not id then
    return false
  end
  local result = tmux({ 'list-panes', '-a', '-F', '#{pane_id}' })
  if not result then
    return false
  end
  for line in result:gmatch('[^\r\n]+') do
    if line == id then
      return true
    end
  end
  return false
end

local function find_owned_pane()
  local result = tmux({ 'list-panes', '-a', '-F', '#{pane_id} #{@opencode_nvim_owner}' })
  if not result then
    return nil
  end
  for line in result:gmatch('[^\r\n]+') do
    local id, owner = line:match('^(%S+)%s*(.*)$')
    if id and owner == pane_owner and tmux_pane_exists(id) then
      return id
    end
  end
  return nil
end

local function active_pane_id()
  if tmux_pane_exists(pane_id) then
    return pane_id
  end

  local id = find_owned_pane()
  set_pane_id(id)
  return id
end

local function get_pane_pid(id)
  local result = tmux({ 'list-panes', '-a', '-F', '#{pane_id} #{pane_pid}' })
  if not result then
    return nil
  end
  for line in result:gmatch('[^\r\n]+') do
    local pane, pid = line:match('^(%S+)%s+(%S+)$')
    if pane == id then
      return tonumber(pid)
    end
  end
  return nil
end

server_stop = function()
  local id = active_pane_id()
  if not id then
    return
  end

  local pid = get_pane_pid(id)
  if pid then
    pcall(vim.fn.jobstart, { 'sh', '-c', 'kill -TERM -"$1"', 'opencode-kill', tostring(pid) })
  else
    pcall(vim.fn.jobstart, { 'tmux', 'kill-pane', '-t', id })
  end
  set_pane_id(nil)
end

server_start = function()
  if active_pane_id() then
    return
  end

  local result = tmux({ 'split-window', '-d', '-P', '-F', '#{pane_id}', '-h', '-p', '50', 'opencode --port' })
  if not result then
    vim.notify('Failed to start opencode tmux pane', vim.log.levels.ERROR)
    return
  end

  local id = vim.trim(result)
  if id == '' then
    vim.notify('Failed to get tmux pane id', vim.log.levels.ERROR)
    return
  end

  set_pane_id(id)
  tmux({ 'set-option', '-p', '-t', id, 'allow-passthrough', 'off' })
  tmux({ 'set-option', '-p', '-t', id, pane_owner_option, pane_owner })
end

server_toggle = function()
  if active_pane_id() then
    server_stop()
  else
    server_start()
  end
end

local opencode_config = package.loaded['opencode.config']
if opencode_config and opencode_config.opts then
  opencode_config.opts.server = vim.g.opencode_opts.server
end

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
