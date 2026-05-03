# analyze-mac-rime

## Overview

本计划详细分析 `mac_rime/` 目录下的 Rime 输入法 macOS 配置。该配置基于「袖珍简化字拼音」方案深度定制，包含完整的词库体系、Lua 扩展、符号映射、跨平台前端主题及八股文语言模型。

## Directory Structure

```
mac_rime/
├── default.custom.yaml         # 全局默认配置补丁
├── pinyin_simp.schema.yaml     # 拼音输入方案主配置
├── melt_eng.schema.yaml        # 英文输入方案（作为依赖挂载）
├── symbols.custom.yaml         # 标点与符号映射
├── rime.lua                    # Lua 扩展脚本
├── squirrel.custom.yaml        # macOS 鼠须管前端配置
├── weasel.custom.yaml          # Windows 小狼毫前端配置（备用）
├── pinyin_simp.dict.yaml       # 拼音主词库入口
├── melt_eng.dict.yaml          # 英文主词库入口
├── custom_phrase.txt           # 自定义短语（固顶字）
├── zh-hans-t-essay-bgw.gram    # 八股文语言模型
├── cn_dicts/                   # 中文词库（6 个文件）
├── en_dicts/                   # 英文词库（3 个文件）
└── opencc/                     # OpenCC 转换配置
    ├── emoji.json
    └── emoji.txt
```

## Core Configuration

### `default.custom.yaml`

- `schema_list`: 仅挂载 `pinyin_simp` 单一方案
- `menu/page_size`: 候选栏显示 5 个候选项
- `ascii_composer`: Caps Lock 仅切换大小写；左右 Shift 上屏拼音代码并切换英文
- `switcher/hotkeys`: `Control+Shift+grave` 呼出方案选单
- `recognizer/patterns`: 自动识别 email、URL、全大写单词并切换英文模式
- `key_binder`: 绑定 Emacs 风格编辑键（`Ctrl+P/N/K/J/B/F/H/D/A/E`）；`Tab/Shift+Tab` 在拼音间跳跃光标；`-/=` 翻页；`` ` `` 取首字、`/` 取尾字

### `pinyin_simp.schema.yaml`

- **switches**: `ascii_mode`, `full_shape`, `ascii_punct`, `emoji`（默认开启）, `traditionalization`
- **engine/processors**: `lua_processor@select_character` → `ascii_composer` → `recognizer` → `key_binder` → `speller` → `punctuator` → `selector` → `navigator` → `express_editor`
- **engine/translators**: `punct_translator` → `script_translator` → `lua_translator@v_single_char_first_filter` → `lua_translator@date_translator` → `table_translator@custom_phrase` → `table_translator@melt_eng`
- **engine/filters**: `lua_filter@long_word_filter` → `simplifier@emoji` → `simplifier@traditionalize` → `uniquifier`
- **translator/initial_quality**: `1.2`（中文权重）
- **melt_eng/initial_quality**: `1.1`（英文权重略低于中文）
- **custom_phrase/initial_quality**: `99`（固顶字最高优先级）
- **grammar**: 挂载 `zh-hans-t-essay-bgw` 八股文语言模型，启用上下文建议
- **speller/algebra**: 20+ 条拼写规则，包括超级简拼、`zh/ch/sh` 整体简拼、`v/u` 互换、以及大量常见拼音纠错（如 `agn→ang`, `tain→tian`, `hsi→shi`）
- **recognizer/patterns/punct**: `^v([a-zA-Z]+|[0-9]0?)$`，将 `/` 模式改为 `v` 模式触发符号输入

### `melt_eng.schema.yaml`

- `schema_id`: `melt_eng`，作为 `pinyin_simp` 的 `dependencies` 被调用
- `Easy English Nano` 精简英文方案，仅含常用词汇方便中英混输
- `speller/alphabet` 包含大小写字母及 `-_`
- `derive` 规则支持大小写混写自动转写
- `punctuator` 被注释，由主方案统一控制标点

### `symbols.custom.yaml`

- 将官方默认的 `/` 符号模式改为 `v` 模式
- `half_shape` 个性化映射：单引号 `'` → `「」`，方括号 `[`/`]` → `【】`，反斜杠 `\` → `、`
- `symbols` 收录海量分类符号：
  - `vpy`/`vpyd` — 拼音声调（小写/大写）
  - `vjt` — 箭头，`vsx` — 数学，`vxl`/`vxld` — 希腊字母
  - `vjm`/`vpjm` — 平假名/片假名，`vey`/`veyd` — 俄文字母
  - `vzz` — Mac 键盘符号（`⌘⌥⇧⌃`）
  - `vdd`/`vss`/`vaa` — Emoji 表情、手势、动物
  - `vcmd`/`vopt`/`vreturn` — 单个 Mac 键位符号

## Lua Extensions (`rime.lua`)

### `date_translator`

通过 `input` 匹配触发，产出动态时间候选并设置 `quality = 100`：

| input | output 示例 |
|-------|-------------|
| `rq` | `2026-05-03`, `2026/05/03`, `2026年05月03日` |
| `sj` | `13:28`, `13:28:00` |
| `xq` | `周日`, `星期日` |
| `dt` | `2026-05-03T13:28:00+08:00` |
| `ts` | Unix 时间戳 |

### `select_character`

通过 `utf8_sub` 实现 UTF-8 字符级截取：
- `key_binder/select_first_character`（默认 `` ` ``）：上屏候选词首字
- `key_binder/select_last_character`（默认 `/`）：上屏候选词尾字

### `long_word_filter`

- 遍历候选列表，将 3 个比首词更长的纯汉语词条提前到第 `idx=3` 位
- 通过正则 `[%w%p%s]+` 排除英文及中英混输词条

### `v_single_char_first_filter`

- 当输入为 `v` 开头且长度为 2 时（如 `va`），强制插入一个空候选
- 解决因 `melt_eng` 的 `initial_quality > 1` 导致英文单词排在拼音声调符号之前的问题

## Dictionary System

### Chinese Dictionaries (`cn_dicts/`)

| file | description |
|------|-------------|
| `8105.dict.yaml` | 《通用规范汉字表》8105 字基础字表 |
| `main.dict.yaml` | 核心系统词库，合并华宇野风、现代汉语常用词表、清华大学开源词库，经去重/调频/纠错/人工校对 |
| `ext.dict.yaml` | 扩展词库 |
| `others.dict.yaml` | 杂项词条 |
| `av.dict.yaml` | 影视领域专有名词 |
| `zhwiki.dict.yaml` | 百万维基百科词条 |

`pinyin_simp.dict.yaml` 通过 `import_tables` 按上述顺序挂载。

### English Dictionaries (`en_dicts/`)

| file | description |
|------|-------------|
| `en.dict.yaml` | 基础英文词汇 + IT 领域缩写（CPU, RAM, SSD, WiFi, UTF, ASCII 等） |
| `en_ext.dict.yaml` | 扩展英文词汇 |
| `cn_en.dict.yaml` | 中英混输词条 |

### `custom_phrase.txt`

- 使用 `table_translator` + `stabledb`，权重 `99`
- **不参与造句**，因此仅配置缩写编码，避免污染用户词库
- 内容结构：
  1. **单字母固顶字**：每个声母映射 1-5 个最高频字（如 `d→的/地/得`, `s→是/时/使/式`）
  2. **高频简拼**：`wm→我们`, `tm→他们/她们/它们`, `td→他的/她的/它的`
  3. **固定短语**：`sig→是一个`, `umu→有没有`, `uuuu→又双叒叕`

## Frontend UI

### `squirrel.custom.yaml` (macOS)

- **app_options**:
  - `com.microsoft.VSCode`: `ascii_mode: false`（VS Code 内默认中文）
  - `com.googlecode.iterm2`: `ascii_punct: true`, `vim_mode: true`
- **color_scheme**: `system_blue`
- **color_scheme_dark**: `purity_of_form_custom`
- **system_blue** 细节：
  - `candidate_list_layout: linear`, `text_orientation: horizontal`
  - `inline_preedit: true`
  - 字体：`MiSans` 16pt，编号 `SFCompactText-Regular` 14pt
  - 候选格式：`%c.\u2005%@ \u2005`（1/6 em 空格分隔）
  - 圆角：候选条 6px，高亮项 4px，首选项橙底白字 `0xF8AA4D`
- **preset_color_schemes**: 包含官方全部内置主题 + `purity_of_form_custom`（柔化暗色版）

### `weasel.custom.yaml` (Windows)

- 备用配置，默认主题 `psionics`
- 字体 `Microsoft YaHei` 14pt
- 垂直排列 (`horizontal: false`)

## OpenCC & Language Model

### `opencc/`

- `emoji.json`: 配置 `mmseg` 分词 + text dict 转换链
- `emoji.txt`: 格式为 `输入<Tab>输出1 输出2 ...`，内容包含 Emoji 映射及偏旁部首名称映射（如 `单人旁<tab>亻`）

### `zh-hans-t-essay-bgw.gram`

- 八股文语言模型（Grammar）
- 在 `pinyin_simp.schema.yaml` 中通过 `grammar` 节点挂载
- `translator/contextual_suggestions: true` 启用上下文感知排序

## Key Characteristics

1. **单方案精简**: 仅启用 `pinyin_simp`，无方案切换心智负担
2. **Lua 深度增强**: 日期时间、以词定字、长词优先、v模式单字优先四个自定义模块
3. **高质量词库**: 多源合并 + 人工调频 + 20+ 条纠错规则
4. **符号体系完善**: `v` 模式覆盖声调、数学、箭头、假名、希腊/俄文、Emoji、Mac 键位符号
5. **跨平台兼容**: 同时维护 `squirrel.custom.yaml`（macOS）与 `weasel.custom.yaml`（Windows）
6. **固顶字策略清晰**: `custom_phrase.txt` 使用 `stabledb` 确保高频缩写永远首位且不干扰造词
