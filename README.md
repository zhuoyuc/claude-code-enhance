# Claude Code Enhance

为 VSCode Claude Code 扩展添加代码高亮、LaTeX 公式渲染、UI 优化、AI 对话复制等功能。

## 功能特性

- **代码语法高亮** — Highlight.js,支持 180+ 种语言
- **LaTeX 公式渲染** — KaTeX + 针对 CC webview 的 markdown 兼容层,支持矩阵/分数/积分/Frobenius `\!:\!`/物理包命令等
- **LaTeX 自动修复** — 针对 CC markdown pipeline 对数学源码的系统性破坏,做统一归一化(详见下方)
- **AI 对话复制** — 一键复制 AI 回复 Markdown(排除思维链和工具调用)
- **DOM 探测工具** — `Ctrl+Shift+D` 导出 DOM 结构
- **KaTeX 源码探测** — `Ctrl+Shift+L` 导出所有公式的 annotation + 归一化结果(debug 用)
- **表格暗色主题** — 渐变表头,悬停高亮,圆角边框
- **表格内 display 公式** — CSS 强制 inline-block,不打断单元格内容流
- **代码自动换行** — 长命令行自动换行显示
- **滚轮缩放** — `Ctrl + 滚轮` 缩放界面(50%–200%)
- **列表样式修复** — 有序列表数字正常显示

## 兼容版本

- **VSCode Claude Code 扩展**:2.1.31(初代)/ 2.1.112 / 2.1.116(含 Remote-SSH 场景)
- **平台**:Windows (win32-x64)、Linux (linux-x64)、macOS (darwin-arm64 与 darwin-x64,通过 VSCode Remote 间接)

## 安装

### 方式一:本地扩展(`~/.vscode/extensions/`)

```bash
cd claude-code-enhance
node patch_extension.js
```

### 方式二:VSCode Remote / vscode-server(`~/.vscode-server/extensions/`)

在 Remote-SSH 会话里,扩展装在远端 `~/.vscode-server/extensions/` 下。使用专用脚本:

```bash
node patch_extension_server.js
```

两个脚本都会自动:
1. 查找已安装的 Claude Code 扩展目录(`.vscode` / `.vscode-server`)
2. 复制 `webview/enhance.js` 到扩展目录
3. 修改 CSP 允许加载 CDN 资源
4. 动态检测并注入 `<script src="enhance.js">`(处理不同版本的变量名混淆)
5. **幂等**:扩展更新后重跑即可,不会重复注入

## 安装后

**完全关闭 Claude Code 面板**(点 ×)再重新打开。注意:
- `Developer: Reload Window` **不够** —— 该扩展使用 `retainContextWhenHidden`,webview HTML 不会重建
- 必须关闭整个面板再打开,enhance.js 才能加载

## 使用说明

### AI 对话复制

- 鼠标悬停在 AI 回复末尾,右下角出现「复制」按钮
- 点击即把 AI 回复以 Markdown 格式放到剪贴板
- **自动排除**:思维链 (`thinking_*`)、工具调用 (`toolUse_*`)
- **保留格式**:代码块、表格、LaTeX 公式、列表

### 探测与诊断快捷键

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+Shift+D` | 导出当前页面 DOM 结构到剪贴板 |
| `Ctrl+Shift+L` | 导出所有 KaTeX 公式的 annotation 源码 + 归一化结果 |

`Ctrl+Shift+L` 是 LaTeX bug 调试的关键工具 —— 把剪贴板贴回聊天,作者/你可以立刻看到 CC 的 KaTeX 实际接到什么源码,以及 `normalizeMathSource` 能修到什么程度。

### 滚轮缩放

- `Ctrl + 滚轮上`:放大
- `Ctrl + 滚轮下`:缩小
- 范围 50%–200%,自动保存到 localStorage

### LaTeX 公式

| 语法 | 类型 | 示例 |
|------|------|------|
| `$$...$$` | 块级公式 | `$$\sum_{i=1}^n i$$` |
| `$...$` | 行内公式 | `$x^2 + y^2$` |
| `\[...\]` | 块级公式 | `\[\int_0^1 x\,dx\]` |
| `\(...\)` | 行内公式 | `\(e^{i\pi} + 1 = 0\)` |

**CommonMark 兼容**:markdown 渲染器会把 `\[` / `\(` 转义成 `[` / `(`,本脚本能自动检测并恢复渲染。

## 核心:LaTeX 自动修复管道

这是 v2.1.116 之后最关键的功能。CC 的 markdown pipeline 会系统性地破坏数学源码,本脚本的 `normalizeMathSource()` 统一归一化。

### 已知的破坏模式(实测)

| 症状 | 原始 | CC 破坏后 | 视觉表现 |
|------|------|-----------|---------|
| `\,` 等间距符被 escape-escape | `\,\bm{\varepsilon}` | `\\,\bm{\varepsilon}` | `\\` 被 KaTeX 当换行符 → 公式断行 + 字面逗号 |
| `\!` 负薄空格 | `\!:\!` | `\\!:\\!` | 同上,换行 + 字面 `!` |
| 反斜杠被吞 | `\int` | `int` 或 `\|int` | KaTeX 渲染为字面 `int` |
| 下标丢失 | `\Big\|_{u_0}` | `\Big\|{u_0}` 或 `\bigg\|P` | 下标消失或竖线孤立 |
| Unicode 字符混入 | `ν`, `θ`, `Δ` | 原样保留 | KaTeX 把 `\DeltaE` 当未知命令 |

### 归一化管道(按顺序)

`normalizeMathSource(tex)` = 5 步纯函数:

1. **`stripEscapedBackslashPunct`** — `\\,` → `\,`,`\\;` → `\;`,`\\!` → `\!`,`\\:` → `\:`(矩阵/align 里的合法 `\\` 换行不动)
2. **`normalizeUnicode`** — 60+ 个 Unicode 数学字符 → `\cmd`,多字符替换后补空格避免 `\DeltaE` 冲突
3. **`restoreMissingBackslashes`** —
   - LEAD_PIPE_RE: `|cmd`(`|` 前非字母数字,`cmd` 不是 label 命令)→ `\cmd`
   - BARE_CMD_RE: 130+ 个裸命令 → `\cmd`
4. **`restoreMissingSubscript`** —
   - `\Big|{X}` / `\bigg|P` → `\Big|_{X}` / `\bigg|_P`
   - `\int\text{top}` → `\int_\text{top}`
   - `\mathbf{u}|\text{X}` → `\mathbf{u}|_\text{X}` (eval-bar)
5. **`restoreMathSpacing`** — 所有规则带 `(?<!\\)` 负向 lookbehind,防止二次加反斜杠
   - `,\cmd` / `},letter` → `\,`
   - `;\cmd` / `;=` / `=;` → `\;`
   - `:\cmd` → `\:`
   - `!:` / `:!` / `!\cmd` → `\!`(保留阶乘 `n!`)

### KaTeX 宏桥接

KaTeX 不支持 `bm` / `physics` / `braket` 包,但 CC 会输出它们的命令。脚本在 `SIUNITX_MACROS` 里桥接:

- `\bm{X}` → `\boldsymbol{X}` (bm 包)
- `\vb`, `\dv`, `\pdv`, `\abs`, `\norm` (physics 包)
- `\bra`, `\ket`, `\braket` (braket 包)
- `\SI`, `\si`, `\num` + SI 前缀/单位(siunitx 包)

### 作用域护栏

**极其关键**:`normalizeMathSource` 只跑在 AI 聊天消息正文里,绝不碰:

- `MATH_ALLOW_SELECTOR`:`[class*="timelineMessage"]` 内部
- `MATH_DENY_SELECTOR`(14 类)排除:Monaco 编辑器、diff view、`toolUse/toolBody/toolResult/toolSummary`、输入框、代码块、session 列表、`.katex` 自身(除 Pass 2)

早期迭代曾把 Monaco 代码编辑器里的 `$$...$$` 源码渲染成 KaTeX,造成文件编辑器被污染 —— 此护栏防止复发。

### TDD 保障

`webview/test-normalize.js` 是纯 Node 单测,包含 17 条 golden cases(6 正例 + 11 反例/实战 bug):

```bash
node webview/test-normalize.js
# 17/17 passed
```

遇到新 bug 模式时:
1. `Ctrl+Shift+L` 导出实际源码
2. 把 bug 字符串原样加到 `test-normalize.js` 作为失败用例
3. 调规则到通过
4. 同步到 `enhance.js`,部署

## 扩展更新后

Claude Code 扩展更新会覆盖补丁。重新运行:

```bash
node patch_extension.js          # 本地
# 或
node patch_extension_server.js   # remote / vscode-server
```

脚本幂等,安全多次执行。

## 项目结构

```
claude-code-enhance/
├── patch_extension.js          # 补丁脚本(~/.vscode/extensions/)
├── patch_extension_server.js   # 补丁脚本(~/.vscode-server/extensions/,支持动态变量检测)
├── webview/
│   ├── enhance.js              # 增强脚本核心(~1380 行)
│   └── test-normalize.js       # 归一化管道单测(17 golden cases)
└── README.md
```

## 技术细节

### 版本适配

`patch_extension_server.js` 会**动态检测** CC 扩展里的 webview 变量名(每版混淆后不一样),不需要手动改:

| 版本 | `asWebviewUri` 绑定 | `Uri.joinPath` 命名空间 |
|------|--------------------|------------------------|
| 2.1.31 | `z` | `F0` |
| 2.1.112 | `K` | `S0` |
| 2.1.116 | `V` | `S0` |

### CSP 修改

- `style-src`:加 `https://cdnjs.cloudflare.com`
- `script-src`:加 `https://cdnjs.cloudflare.com`
- `font-src`:加 `https://cdnjs.cloudflare.com data:`

### AI 对话复制实现

由于 CC 扩展代码经过混淆,直接修改不可行。本项目采用 **DOM 注入 + 模糊选择器**:

1. 使用 `[class*="timelineMessage_"]` 等模糊选择器定位元素
2. 类名前缀排除思维链 (`thinking_*`) 和工具调用 (`toolUse_*`)
3. 递归遍历 DOM 把 HTML 转回 Markdown
4. MutationObserver 动态添加复制按钮

### LaTeX 渲染三通道

当 CC 原生 KaTeX 渲染失败或源码被 mangle 后:

1. **`renderLaTeX`** —— 在文本节点级处理 `$..$`、`$$..$$`、`\(..\)`、`\[..\]` 及 CommonMark 后的 `[..]`、`(..)`
2. **`renderBlockDisplayMath`** —— 跨节点的多行 `$$..$$` 兜底(markdown 把公式拆成多个 `<p>` 时)
3. **`repairKatexErrors`** ——
   - Pass 1:CC 原生渲染产出 `.katex-error` 的硬错误,归一化后重渲染
   - Pass 2:CC 渲染"成功"但 annotation 源有 mangle 痕迹,归一化后重渲染

所有三个通道都走**同一个** `normalizeMathSource`,行为一致。

### 外部依赖

- [Highlight.js](https://highlightjs.org/) 11.9.0(vs2015 主题)
- [KaTeX](https://katex.org/) 0.16.9

## 开发方法论

本项目采用 **TDD + Plan-Driven Development**:

1. **`/plan` 计划先行** — 重大重构先写计划文件,分析风险、列出修改范围
2. **TDD 规则** — 所有字符串归一化规则先在 `test-normalize.js` 里写成 golden case,再改 `enhance.js`
3. **实战数据反馈** — 用户遇到 bug 时,`Ctrl+Shift+L` 导出实际 annotation,失败字符串原样作为新测试用例
4. **作用域优先** — 任何 DOM 修改都要先确认 `MATH_ALLOW_SELECTOR` + `MATH_DENY_SELECTOR` 护栏到位
5. **部署是 `patch_extension*.js` + 关闭重开面板**,不要依赖 `Reload Window`

### 一次典型循环

```
1. Ctrl+Shift+L 导出 KaTeX 源,发现新的 mangle 模式
2. 把 bug 字符串加到 test-normalize.js 作为失败用例
3. node webview/test-normalize.js  →  失败
4. 调 normalizeMathSource 的规则(加新规则或调现有规则)
5. node webview/test-normalize.js  →  全通过
6. 把改动同步到 enhance.js
7. node patch_extension_server.js  →  部署
8. 用户关闭 × 重开 Claude Code 面板 → 验证
9. git commit + push
```

## License

MIT
