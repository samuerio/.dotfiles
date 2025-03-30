vim.g.NERDTreeMapOpenSplit = 's'
vim.g.NERDTreeMapOpenVSplit = 'v'

vim.cmd([[
    let NERDTreeShowBookmarks=1
    let NERDTreeIgnore=['\.py[cd]$', '\~$', '\.swo$', '\.swp$', '^\.git$', '^\.hg$', '^\.svn$', '\.bzr$']
    let NERDTreeChDirMode=0
    let NERDTreeQuitOnOpen=1
    let NERDTreeMouseMode=2
    let NERDTreeShowHidden=1
    let NERDTreeKeepTreeInNewTab=1
    let g:nerdtree_tabs_open_on_gui_startup=0

    " NERDTrees File highlighting
    function! NERDTreeHighlightFile(extension, fg, bg, guifg, guibg)
        exec 'autocmd FileType nerdtree highlight ' . a:extension .' ctermbg='. a:bg .' ctermfg='. a:fg .' guibg='. a:guibg .' guifg='. a:guifg
        exec 'autocmd FileType nerdtree syn match ' . a:extension .' #^\s\+.*'. a:extension .'$#'
    endfunction

    highlight! link NERDTreeFlags NERDTreeDir
    highlight NERDTreeFile ctermfg=14

]])

utils.nmap('<C-e>', ':NERDTreeToggle<CR>')
utils.nmap('<leader>n', ':NERDTreeFind<CR>')

-- plugins/nerdtree.lua
local function avante_add_files(dirnode)
    -- 获取当前节点的文件路径（转换为字符串）
    local segments = dirnode.path.pathSegments
    local filepath = "/" .. table.concat(segments, "/")
    print(filepath)

    local relative_path = require("avante.utils").relative_path(filepath)
    local sidebar = require("avante").get()
    local is_open = sidebar:is_open()

    if not is_open then
        require("avante.api").ask()
        sidebar = require("avante").get()
    end

    sidebar.file_selector:add_selected_file(relative_path)

    if not is_open then
        sidebar.file_selector:remove_selected_file("NERD_tree_tab_1")
    end
end

vim.api.nvim_create_autocmd("VimEnter", {
    callback = function()
        vim.fn.NERDTreeAddKeyMap({
            key = "aa",
            callback = avante_add_files,
            quickhelpText = "Add to Avante",
            scope = "Node",
        })
    end,
})
