# SI Search

一款面向 C/C++ 开发者的 Source Insight 风格代码搜索 VS Code 扩展，专为大型代码库设计。

SI Search 使用 tree-sitter 解析器预先构建**符号索引**，实现跨工作区的即时符号查找。当索引未覆盖的查询自动回退到 ripgrep 全文搜索。

## 功能特性

### 符号索引（Sync）

SI Search 使用 [tree-sitter](https://tree-sitter.github.io/)（WASM 版本）解析工作区中所有 C/C++ 源文件，提取符号定义：

- **函数** &mdash; `int main()`、`void foo()`
- **结构体** &mdash; `struct device`
- **枚举** &mdash; `enum state`
- **类型定义** &mdash; `typedef unsigned int uint32_t`
- **宏定义** &mdash; `#define MAX_SIZE 1024`、`#define INIT(x) ...`
- **类**（C++）&mdash; `class Widget`
- **命名空间**（C++）&mdash; `namespace std`
- **联合体** &mdash; `union data`

索引持久化到磁盘（工作区根目录下的 `.sisearch/index.json`），VS Code 重启后自动恢复，无需重新扫描。

按 `Ctrl+Shift+S` 或点击搜索面板标题栏的同步按钮来构建/更新索引。

### 两级搜索策略

1. **索引搜索**（即时）&mdash; 符号索引就绪时，查询直接匹配内存索引，精确查找 O(1)，子串/正则快速扫描。
2. **Ripgrep 回退** &mdash; 索引无结果时（例如搜索字符串字面量而非符号名），自动回退到 ripgrep 全文搜索。

这种混合方式兼顾了预建索引的速度和全文搜索的覆盖面。

### 搜索结果面板

- **语法高亮预览** &mdash; 鼠标悬停在结果的代码部分，弹出多行预览窗口，带完整语法高亮（基于 [shiki](https://shiki.matsu.io/)），自动匹配当前 VS Code 主题配色。
- **跳转到源码** &mdash; 点击结果行的箭头图标，在编辑器中打开对应文件并定位到精确行。
- **逐条导航** &mdash; 使用 `Ctrl+Shift+F4` / `Ctrl+Shift+F3` 逐条浏览搜索结果。
- **行号栏标记** &mdash; 包含搜索结果的源文件在编辑器行号栏显示蓝色三角标记。
- **CodeLens 链接** &mdash; 匹配行上方显示 "Jump to Search Result" CodeLens，可快速导航回结果面板。

### 搜索过滤（Include / Exclude）

点击搜索框旁正则切换按钮右侧的 `⋯` 按钮，展开 **files to include** 和 **files to exclude** 输入框——与 VS Code 原生搜索的用法一致。

- **Files to include** &mdash; 逗号分隔的 glob 模式（如 `*.c, src/**`）。指定后**替代** `includeFileExtensions` 设置。
- **Files to exclude** &mdash; 逗号分隔的 glob 模式（如 `**/test/**, **/build/**`）。与 `excludePatterns` 设置**合并**生效。
- 在搜索框、include、exclude 任一输入框中按 `Enter` 均可触发搜索。

### 手动高亮标记

- 按 `Ctrl+Shift+F8` 高亮选中文本（或在结果面板中触发选择提示）。
- 多种高亮颜色自动轮换。
- 高亮同时显示在结果面板和所有打开的编辑器中。
- 侧边栏的高亮树视图显示所有活跃的高亮标记，支持逐个删除。

### 增量文件监听

SI Search 监控工作区文件变更：

- **修改/新建文件** 被标记为脏文件，状态栏显示 "stale"。
- **删除的文件** 自动从索引中移除。
- 重新同步（`Ctrl+Shift+S`）仅重新解析变更的文件，而非整个工作区。

## 架构

```
文件系统 ── SymbolParser (web-tree-sitter WASM) ── SymbolIndex (内存 + 磁盘)
                                                          |
                                                     SearchEngine
                                                    /            \
                                            索引搜索         Ripgrep 回退

FileWatcher ── 标记 脏文件/删除文件 ── SymbolIndex
```

**核心组件：**

| 组件 | 文件 | 职责 |
|------|------|------|
| SymbolParser | `src/symbolParser.ts` | tree-sitter WASM 初始化、语法加载、通过 S-expression 查询提取符号 |
| SymbolIndex | `src/symbolIndex.ts` | 双 Map 内存索引（`symbolsByFile` + `nameIndex`），全量/增量同步，磁盘持久化 |
| FileWatcher | `src/fileWatcher.ts` | VS Code `FileSystemWatcher` 封装，追踪脏文件和已删除文件 |
| SearchEngine | `src/searchEngine.ts` | Ripgrep 封装 + `executeSearchWithIndex()` 混合调度器 |
| SyntaxHighlight | `src/syntaxHighlight.ts` | 基于 Shiki 的代码着色，用于悬浮预览，集成 VS Code 主题 |

## 命令

| 命令 | 标题 | 默认快捷键 |
|------|------|------------|
| `siSearch.focusSearchPanel` | SI Search: 聚焦搜索面板 | `Ctrl+/`（macOS: `Cmd+/`） |
| `siSearch.toggleResultsPanel` | SI Search: 切换结果面板 | `Ctrl+Shift+/`（`Cmd+Shift+/`） |
| `siSearch.syncIndex` | SI Search: 同步文件索引 | `Ctrl+Shift+S`（`Cmd+Shift+S`） |
| `siSearch.clearIndex` | SI Search: 清除符号索引 | &mdash; |
| `siSearch.nextResult` | SI Search: 下一个结果 | `Ctrl+Shift+F4`（`Cmd+Shift+F4`） |
| `siSearch.previousResult` | SI Search: 上一个结果 | `Ctrl+Shift+F3`（`Cmd+Shift+F3`） |
| `siSearch.highlightSelection` | SI Search: 高亮选中文本 | `Ctrl+Shift+F8`（`Cmd+Shift+F8`） |
| `siSearch.clearAllHighlights` | SI Search: 清除所有高亮 | &mdash; |
| `siSearch.jumpToResult` | SI Search: 从源码跳转到结果 | `Alt+J` |
| `siSearch.clearResults` | 清除搜索结果 | &mdash; |
| `siSearch.removeHighlight` | 移除高亮 | &mdash; |

## 配置项

所有设置位于 VS Code 设置中的 `siSearch.*` 命名空间下。

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `siSearch.includeFileExtensions` | `string[]` | `[".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".inl"]` | 纳入搜索和符号索引的文件扩展名。 |
| `siSearch.includePaths` | `string[]` | `[]` | 符号索引仅扫描的子目录（如 `["src/wifi", "src/drivers"]`）。为空表示扫描整个工作区。 |
| `siSearch.excludePatterns` | `string[]` | `["**/build/**", "**/.git/**", "**/node_modules/**"]` | 从搜索中排除的 glob 模式。 |
| `siSearch.highlightColors` | `string[]` | `["cyan", "pink", "lightgreen", "magenta", "cornflowerblue", "orange", "green", "red"]` | 手动高亮标记的颜色列表，按顺序轮换使用。 |
| `siSearch.highlightBox` | `boolean` | `true` | `true` 时高亮使用边框样式；`false` 时使用背景填充样式。 |
| `siSearch.navigationWrap` | `boolean` | `true` | 导航到最后/最前一个结果时是否循环跳转。 |
| `siSearch.autoSyncOnSave` | `boolean` | `false` | 保存文件时自动增量同步脏文件。 |
| `siSearch.parser.maxFileSizeBytes` | `number` | `1048576` (1 MB) | 超过该字节数的文件改走正则流式提取，不再进 tree-sitter AST 解析器。详见下文 [大文件处理](#大文件处理)。设为 `0` 可禁用（不推荐，具体原因见配置项的 WARNING 说明）。 |

### 配置示例 `.vscode/settings.json`

```jsonc
{
    // 仅索引这些子目录下的文件（为空 = 整个工作区）
    "siSearch.includePaths": ["src/wifi", "src/drivers"],

    // 搜索和索引的文件扩展名
    "siSearch.includeFileExtensions": [".c", ".h", ".cpp", ".hpp"],

    // 所有搜索中排除的 glob 模式
    "siSearch.excludePatterns": ["**/build/**", "**/.git/**", "**/node_modules/**"]
}
```

## 搜索选项

搜索输入框支持三个切换选项：

- **区分大小写**（`Aa`）&mdash; 精确匹配字母大小写。
- **全字匹配**（`W`）&mdash; 仅匹配完整单词（对应 ripgrep 的 `--word-regexp` 或索引精确名称匹配）。
- **正则表达式**（`.*`）&mdash; 将查询解释为正则表达式。

## 侧边栏视图

SI Search 在活动栏中提供独立的视图容器，包含两个视图：

| 视图 | ID | 说明 |
|------|----|------|
| Search | `siSearch.searchPanel` | 搜索输入框、选项切换和搜索历史列表的 Webview。 |
| Highlights | `siSearch.highlightsView` | 显示所有活跃手动高亮的树视图，每项带有移除按钮。 |

## 状态栏

状态栏项（左下角）显示当前索引状态：

| 状态 | 显示 | 含义 |
|------|------|------|
| None | `$(database) Index: None` | 尚未构建索引，点击触发同步。 |
| Building | `$(sync~spin) Index: Syncing...` | 索引构建中。 |
| Ready | `$(database) 15,234 symbols` | 索引就绪，显示符号总数。 |
| Stale | `$(database) 15,234 symbols (stale)` | 上次同步后有文件变更，点击重新同步。 |

## 工作原理

### 符号解析

SI Search 在运行时加载 tree-sitter 的 C 和 C++ WASM 语法文件。对每个源文件执行 S-expression 查询提取符号定义：

```scheme
;; 示例：提取函数名
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @def
```

每个提取的符号记录：名称、类型、文件路径、行号、列号和所在行的文本内容。

### 大文件处理

Tree-sitter 在 WebAssembly 运行时里跑，其线性内存被 web-tree-sitter 硬性限制在 2 GB。机器生成的 C/C++ 头文件（例如 GPU 寄存器定义、协议 schema 头文件）可以达到几十兆，包含十万级的 `#define` 指令。用 tree-sitter 解析这类文件可能把 WASM 堆耗尽，导致 extension host `exit 134 / SIGABRT` 崩溃。

SI Search 按文件大小路由：

| 文件大小 | 路径 | 行为 |
|---------|------|------|
| `< maxFileSizeBytes`（默认 1 MB） | **tree-sitter** | 完整 AST，支持所有符号类型，保留 `lineContent`。 |
| `≥ maxFileSizeBytes` 且 `< 10 MB` | **流式正则** | `readline` 逐行 + 正则提取 `#define`、`struct`、`union`、`enum`、`class`、`namespace`、简单函数定义。丢弃 `lineContent` 保持内存稳定。 |
| `≥ 10 MB` | **流式正则，`macrosOnly`** | 只抽 `#define`，跳过去重集合。 |

**重要:** 流式路径提取的符号**只计数不入索引**。它们会记在文件 metadata 里（让增量同步知道该文件已处理），但**不会出现在搜索结果中**。

设计考量：在 33k 文件的 Linux 内核 `drivers/` 目录下，触发流式路径的约 30 个寄存器头文件大约贡献 450 万个机器生成的宏名。如果把这些全部塞进主线程的 `InMemorySymbolIndex`，堆峰值会到 2-3 GB 撑爆 Node V8 运行时。默认设计是以"这类头文件搜不到"换"扩展不崩溃"。确实需要定位某个寄存器宏的用户可以用 VS Code 内置文本搜索（`Ctrl+Shift+F`）或对源文件 `grep`。

**覆盖默认值:**
- 把 `siSearch.parser.maxFileSizeBytes` 设得更大会让更多文件走 tree-sitter，但也会重新暴露在 WASM 爆堆的风险下。
- 设为 `0` 则完全禁用流式路径——仅当你确信工作区里没有机器生成的巨型头文件时才建议这么做。

### 诊断日志

遇到崩溃需要复现定位时，启动 VS Code 前设置环境变量 `SISEARCH_WORKER_DIAG=1`。parse worker 会把 JSON-Lines 日志写到 `$TMPDIR/sisearch-worker-<pid>.log`，每个文件的进入/读取/解析事件单独一行。崩溃后查看最新日志：

```bash
ls -t /tmp/sisearch-worker-*.log | head -1 | xargs tail -20
```

环境变量未设置时诊断路径完全是 no-op，日常使用不受影响。

### 索引结构

内存索引使用双 Map 结构以适应不同的访问模式：

- **`symbolsByFile`**（`Map<相对路径, SymbolEntry[]>`）&mdash; 增量更新时 O(1) 按文件移除。
- **`nameIndex`**（`Map<小写名称, SymbolEntry[]>`）&mdash; O(1) 精确查找和快速子串扫描。

### 磁盘持久化

索引序列化为 `{工作区根目录}/.sisearch/index.json`，JSON 格式：

```json
{
  "version": 1,
  "createdAt": 1712700000000,
  "workspaceRoot": "/path/to/workspace",
  "files": [{ "relativePath": "...", "mtime": ..., "size": ..., "symbolCount": ... }],
  "symbols": [{ "name": "...", "kind": "function", "filePath": "...", ... }]
}
```

VS Code 启动时自动从磁盘加载索引。`version` 字段确保向前兼容——格式变更时旧索引会被丢弃并重建。

### 增量同步

同步时，SI Search 对比每个文件的 `mtime` 和 `size` 与存储的元数据。仅处理新增、修改或删除的文件。这使得大型代码库（如 Linux 内核）的重新同步只需数秒而非数分钟。

## 系统要求

- VS Code 1.85.0 或更高版本。
- 无需安装外部依赖。所有 tree-sitter WASM 语法文件和 ripgrep 二进制文件均随扩展一同打包。

## 从源码构建

### 前置条件

- [Node.js](https://nodejs.org/) 18+ 及 npm
- [VS Code](https://code.visualstudio.com/) 1.85.0+

### 安装依赖

```bash
npm install
```

### 编译

```bash
npm run compile
```

执行 `tsc -p ./`，将 TypeScript 编译到 `out/` 目录。

### 监听模式（开发用）

```bash
npm run watch
```

### 打包为 VSIX

```bash
npx @vscode/vsce package
```

该命令会依次：
1. 将 WASM 文件从 `node_modules` 复制到 `wasm/` 目录（`npm run copy-wasm`）
2. 编译 TypeScript（`npm run compile`）
3. 将所有文件打包为 `sisearch-<version>.vsix`

### 安装 VSIX

```bash
code --install-extension sisearch-<version>.vsix
```

或在 VS Code 中：`Ctrl+Shift+P` → `Extensions: Install from VSIX...`

## 已知限制

- 符号索引目前仅支持 **C 和 C++**。其他语言回退到 ripgrep 全文搜索。
- 悬浮预览通过 shiki 使用当前 VS Code 主题渲染代码，部分自定义主题可能显示不完美。
- `.sisearch/` 目录会创建在工作区根目录下，如需要请将其添加到 `.gitignore`。
- **机器生成的大型头文件不可按符号搜索。** 超过 `siSearch.parser.maxFileSizeBytes`（默认 1 MB）的文件改走正则流式提取，其输出只记在文件 metadata 里，不进入可搜索索引。这样做是为了保护扩展在类似 Linux kernel `drivers/` 这种充斥机器生成 GPU 寄存器宏的工作区里不会内存溢出。这类文件请用 VS Code 内置文本搜索。完整 trade-off 分析参见 [大文件处理](#大文件处理)。

## 许可证

MIT
