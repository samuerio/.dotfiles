-- 模仿zed vim mode中的git快捷键
utils.nmap(']h', '<Plug>(GitGutterNextHunk)')
utils.nmap('[h', '<Plug>(GitGutterPrevHunk)')
utils.nmap('do', '<Plug>(GitGutterPreviewHunk)')
utils.nmap('dO', '<Plug>(GitGutterStageHunk)')
utils.nmap('dp', '<Plug>(GitGutterUndoHunk)')
utils.nmap('<leader>gh', ':GitGutterDiffOrig<CR>')
