# vscode-config-cross-platform

## Background

当前 `dotfiles` 仓库中 `vscode/` 目录按平台拆分为 `mac/` 和 `windows/` 两个子目录，各自包含独立的 `settings.json` 和 `keybindings.json`。

日常维护中发现以下问题：
- `settings.json` 中约 80% 的内容（vim 配置、editor 基础设置、terminal 字体等）在两个平台间完全重复，修改时需要手动同步两份文件，维护成本高且容易漂移。
- `keybindings.json` 因 mac 使用 `cmd`、windows/linux 使用 `ctrl`，必须分平台保留。
- windows 配置中部分配置项为平台硬编码路径（如 `java.jdt.ls.java.home`），直接复用到 mac 会静默失效。
- mac 配置中包含大量语言服务器和工具链配置（gitlens、eslint、go、rust-analyzer 等），若被 windows 配置覆盖会导致功能缺失。

## Current State

### File Structure

```
vscode/
├── mac/
│   ├── settings.json
│   └── keybindings.json
└── windows/
    ├── settings.json
    └── keybindings.json
```

### settings.json 差异汇总

| Category | mac 特有 | windows/linux 特有 |
|---------|---------|-------------------|
| theme | `Default Light+`, fontSize 17 | `Default Light Modern`, fontSize 18 |
| java | — | `java.jdt.ls.java.home`, `java.jdt.ls.vmargs`, `java.configuration.runtimes` |
| python | — | `python.analysis.extraPaths` |
| eol | — | `files.eol: "\n"` |
| tools | gitlens, eslint, typescript, go, rust-analyzer, terminal scrollback | — |

### keybindings.json 差异

- mac 使用 `cmd` 修饰键，并覆盖了大量原生快捷键（如 `cmd+d` → deleteLines, `alt+/` → commentLine）。
- windows 使用 `ctrl` 修饰键，映射数量较少，主要解决 vim 与 VS Code 的导航冲突（`ctrl+o/i` → navigateBack/Forward, `ctrl+n/p` → list focus）。

## Goals

1. 消除 `settings.json` 的跨平台重复内容，降低维护成本。
2. 保留 `keybindings.json` 的平台独立性（mac 与 windows/linux 键位方案不可合并）。
3. 确保 mac 迁移到统一配置后，语言服务器、工具链和路径相关配置不会静默失效。
4. 提供可复用的安装/合并脚本，支持一键部署到不同平台。

## Decisions

### Decision 1: settings.json 采用「通用 + 平台覆盖」分层结构

将 `settings.json` 拆分为三层：

- `settings.common.json`: 存放跨平台通用配置（vim、editor 基础设置、terminal 字体等）。
- `settings.mac.json`: 仅存放 mac 特有的覆盖项（主题、语言服务器、工具路径等）。
- `settings.win.json`: 仅存放 windows/linux 特有的覆盖项（Java 路径、Python 路径、行尾符等）。

部署时通过脚本将 `common` 与对应平台的 `json` 合并为最终的 `settings.json`。

### Decision 2: keybindings.json 维持分平台独立文件

`keybindings.mac.json` 和 `keybindings.win.json` 不做合并。原因：
- 修饰键差异（`cmd` vs `ctrl`）是硬件键位决定的，无法抽象。
- mac 用户若强制使用 `ctrl` 方案，会与系统级快捷键（`ctrl+space` 输入法切换等）频繁冲突。

### Decision 3: mac 不全盘迁移 windows 配置

不直接将 `vscode/windows/settings.json` 复制到 mac 使用。原因：
- 硬编码路径（Java、lombok）在 mac 上无效。
- 会丢失 mac 原有的 gitlens、eslint、go、rust-analyzer 等工具链配置。
- 键位习惯冲突严重。

正确的做法是以 `settings.common.json` 为基准，各平台只维护各自的增量覆盖文件。

## Implementation Plan

### Phase 1: 提取公共配置

1. 创建 `vscode/settings.common.json`，将 mac 和 windows 配置中完全一致的部分迁移进去。
2. 创建 `vscode/settings.mac.json`，仅保留 mac 特有项（theme、fontSize、gitlens、eslint、go、rust-analyzer、terminal scrollback 等）。
3. 创建 `vscode/settings.win.json`，仅保留 windows/linux 特有项（theme、fontSize、Java 路径、Python 路径、files.eol 等）。
4. 将现有的 `vscode/mac/keybindings.json` 重命名为 `vscode/keybindings.mac.json`。
5. 将现有的 `vscode/windows/keybindings.json` 重命名为 `vscode/keybindings.win.json`。
6. 删除旧的 `vscode/mac/` 和 `vscode/windows/` 目录。

### Phase 2: 编写合并与部署脚本

1. 在 `vscode/` 下创建 `install.sh`。
2. 脚本逻辑：
   - 检测当前平台（`darwin` / `linux` / `msys` / `cygwin` / `win32`）。
   - 使用 `jq -s 'add'` 合并 `settings.common.json` 与对应平台的 `settings.<platform>.json`。
   - 将合并结果写入 VS Code 用户配置目录：
     - mac: `~/Library/Application Support/Code/User/settings.json`
     - linux: `~/.config/Code/User/settings.json`
     - windows: `%APPDATA%\Code\User\settings.json`
   - 将对应平台的 `keybindings.<platform>.json` 复制为 `keybindings.json`。

### Phase 3: 验证与清理

1. 在 mac 上运行 `install.sh`，验证合并后的 `settings.json` 功能正常。
2. 在 windows/linux 上运行 `install.sh`，验证 Java、Python 等路径配置有效。
3. 确认 git 历史清晰后，提交变更。

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `jq` 未安装导致脚本失败 | 中 | 脚本中检测 `jq` 是否存在，不存在时给出安装提示或使用 Python fallback。 |
| 合并时同 key 的覆盖顺序错误 | 高 | 确保脚本中平台文件在 `common` 之后传入 `jq -s 'add'`，使平台值覆盖通用值。 |
| 旧目录删除后其他脚本引用失效 | 低 | 全局搜索仓库中是否有硬编码引用 `vscode/mac/` 或 `vscode/windows/` 的路径，一并更新。 |
| mac 键位切换成本 | 中 | 明确记录决策：mac 不迁移 windows 键位方案，独立维护 `keybindings.mac.json`。 |

## File Structure (Target)

```
vscode/
├── settings.common.json
├── settings.mac.json
├── settings.win.json
├── keybindings.mac.json
├── keybindings.win.json
└── install.sh
```
