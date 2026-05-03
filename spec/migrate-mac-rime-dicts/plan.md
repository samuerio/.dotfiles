# migrate-mac-rime-dicts

## Overview

将 `mac_rime/` 下不适合 Git 版本控制的超大静态词库和二进制语言模型迁移到 `~/Dropbox/Conf/mac_rime/`，在 Git 中仅保留配置、脚本、主题和小体积入口文件。同步更新 `install.sh`，在 macOS 环境下通过软链接将两部分内容合并部署到 `~/Library/Rime/`。

## Directory Structure

### Before Migration

```
mac_rime/                          (tracked by Git, ~46 MB)
├── cn_dicts/
│   ├── 8105.dict.yaml             (~123 KB)
│   ├── av.dict.yaml               (~4 KB)
│   ├── ext.dict.yaml              (~2.0 MB)
│   ├── main.dict.yaml             (~13 MB)
│   ├── others.dict.yaml           (~2.5 KB)
│   └── zhwiki.dict.yaml           (~18 MB)
├── en_dicts/
│   ├── cn_en.dict.yaml            (~4 KB)
│   ├── en.dict.yaml               (~120 KB)
│   └── en_ext.dict.yaml           (~17 KB)
├── zh-hans-t-essay-bgw.gram       (~9.9 MB)
└── ... (configs, schemas, lua, themes)
```

### After Migration

Git 侧（`mac_rime/`，~1 MB）：

```
mac_rime/
├── .gitignore
├── custom_phrase.txt
├── default.custom.yaml
├── demo.jpeg
├── melt_eng.dict.yaml             # import_tables entry only
├── melt_eng.schema.yaml
├── opencc/
│   ├── emoji.json
│   └── emoji.txt
├── pinyin_simp.dict.yaml          # import_tables entry only
├── pinyin_simp.schema.yaml
├── rime.lua
├── squirrel.custom.yaml
├── symbols.custom.yaml
└── weasel.custom.yaml
```

Dropbox 侧（`~/Dropbox/Conf/mac_rime/`，~43 MB）：

```
Dropbox/Conf/mac_rime/
├── cn_dicts/
│   ├── 8105.dict.yaml
│   ├── av.dict.yaml
│   ├── ext.dict.yaml
│   ├── main.dict.yaml
│   ├── others.dict.yaml
│   └── zhwiki.dict.yaml
├── en_dicts/
│   ├── cn_en.dict.yaml
│   ├── en.dict.yaml
│   └── en_ext.dict.yaml
└── zh-hans-t-essay-bgw.gram
```

## Files Migrated to Dropbox

| File | Size | Description |
|------|------|-------------|
| `cn_dicts/main.dict.yaml` | 13 MB | 系统核心词库，合并华宇野风、现代汉语常用词表、清华开源词库 |
| `cn_dicts/ext.dict.yaml` | 2.0 MB | 扩展词库 |
| `cn_dicts/zhwiki.dict.yaml` | 18 MB | 百万维基百科词库 |
| `cn_dicts/8105.dict.yaml` | 123 KB | 《通用规范汉字表》8105 字基础字表 |
| `cn_dicts/av.dict.yaml` | 4 KB | 影视领域专有名词 |
| `cn_dicts/others.dict.yaml` | 2.5 KB | 杂项词条 |
| `en_dicts/en.dict.yaml` | 120 KB | 英文基础词库 + IT 缩写 |
| `en_dicts/en_ext.dict.yaml` | 17 KB | 扩展英文词汇 |
| `en_dicts/cn_en.dict.yaml` | 4 KB | 中英混输词条 |
| `zh-hans-t-essay-bgw.gram` | 9.9 MB | 八股文语言模型（Grammar） |

迁移理由：
- 体积大，Git diff 无意义
- 内容以「数据」为主而非「配置」，更新时通常是整文件替换
- 集中放在 Dropbox 便于跨机器同步，且与 Git 管理的配置解耦

## Files Kept in Git

| File | Description |
|------|-------------|
| `default.custom.yaml` | 全局补丁，快捷键、候选数、识别器规则 |
| `pinyin_simp.schema.yaml` | 拼音方案引擎配置，含 switches、engine、algebra、grammar |
| `melt_eng.schema.yaml` | 英文方案配置，作为 dependency 被主方案调用 |
| `melt_eng.dict.yaml` | 英文词库入口（仅 `import_tables` 声明，无实际词条） |
| `pinyin_simp.dict.yaml` | 拼音词库入口（仅 `import_tables` 声明，无实际词条） |
| `symbols.custom.yaml` | 标点与符号映射，v 模式符号大全 |
| `rime.lua` | Lua 扩展：日期时间、以词定字、长词优先、v 模式单字优先 |
| `custom_phrase.txt` | 自定义短语（固顶字），经常手动增删 |
| `squirrel.custom.yaml` | macOS 鼠须管前端主题与配色 |
| `weasel.custom.yaml` | Windows 小狼毫前端主题（备用） |
| `opencc/emoji.json` | OpenCC 转换链配置 |
| `opencc/emoji.txt` | Emoji 及偏旁部首映射表 |
| `demo.jpeg` | 演示截图 |

保留理由：
- 体积小（总计 < 1 MB）
- 是「配置」而非「数据」，变更历史有价值
- 需要跨机器通过 Git 同步

## install.sh Changes

新增 `install_mac_rime()` 函数，macOS 专属（`Darwin` 检测）。

逻辑：
1. **链接 Git 管理的配置**
   - 遍历 `${DOTFILES_ROOT}/mac_rime/*`
   - 跳过 `.gitignore`
   - 对每个文件/目录调用 `link_dotfile`，软链接到 `${HOME}/Library/Rime/`

2. **链接 Dropbox 管理的词库**
   - 检查 `~/Dropbox/Conf/mac_rime/` 是否存在
   - 遍历该目录下所有文件/目录
   - 对每个项目软链接到 `${HOME}/Library/Rime/`
   - 自动处理 broken symlink（移除后重建）
   - 若目标已存在则跳过

3. **在 `main()` 中注册**
   - 位于 `install_vscode()` 之后，`install_ghostty()` 之前

## .gitignore Changes

新增 `mac_rime/.gitignore`：

```gitignore
# 词库目录（已迁移到 Dropbox/Conf/mac_rime）
cn_dicts/
en_dicts/
zh-hans-t-essay-bgw.gram

# 运行时生成的文件
build/
sync/
*.userdb/
user.yaml
```

## Deployment Behavior

执行 `./install.sh` 后，`~/Library/Rime/` 的结构如下：

```
~/Library/Rime/
├── default.custom.yaml         -> ~/.dotfiles/mac_rime/default.custom.yaml
├── pinyin_simp.schema.yaml     -> ~/.dotfiles/mac_rime/pinyin_simp.schema.yaml
├── ... (其他 Git 管理的配置文件)
├── cn_dicts/                   -> ~/Dropbox/Conf/mac_rime/cn_dicts/
│   ├── 8105.dict.yaml
│   ├── main.dict.yaml
│   └── ...
├── en_dicts/                   -> ~/Dropbox/Conf/mac_rime/en_dicts/
│   ├── en.dict.yaml
│   └── ...
└── zh-hans-t-essay-bgw.gram    -> ~/Dropbox/Conf/mac_rime/zh-hans-t-essay-bgw.gram
```

Rime/Squirrel 在启动时会自动编译 `.dict.yaml` 为 `.table.bin` 等二进制索引，生成到 `build/` 目录（已被 `.gitignore` 排除）。

## Rationale

- **Git 只管理「配置」**：schema、theme、lua、符号映射、自定义短语等需要版本控制和跨机器同步的内容
- **Dropbox 只管理「数据」**：词库和语言模型体积大、更新方式以整文件替换为主，适合云盘同步
- **install.sh 统一链接**：部署时通过软链接将两个来源合并到 Rime 的标准配置目录 `~/Library/Rime/`，对用户透明
- **空目录已清理**：`cn_dicts/` 和 `en_dicts/` 的空目录已从 Git 工作树中移除，避免软链接时出现目录覆盖冲突
