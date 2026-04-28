/**
 * Claude Code UI 增强脚本 v10
 * 功能: 滚轮缩放, 字体, 表格, LaTeX, 换行, 代码高亮, AI对话复制
 */

(function() {
  'use strict';

  // ========================================================================
  // Phase 2 ROOT-CAUSE FIX: intercept AI message payload BEFORE marked runs
  // ========================================================================
  // CC webview 接收消息: window.addEventListener('message', G => if (G.data.type === 'from-extension') enqueue(G.data.message))
  // 我们在 capture 阶段注册 listener (先于 CC 的 bubble listener),
  // 把每条 assistant/user 消息的 content.text 里的 $...$ 和 $$...$$
  // 替换为占位符 §§CEMATH<id>§§, 把原始 TeX 源码存在 map 里.
  // marked 把占位符当作普通字符串, 不会触发 backslash escape / emphasis /
  // list / code span 等任何 markdown 解析. 最后 enhance.js 在 DOM 里
  // 扫占位符, 用原始 TeX 源码渲染 KaTeX. 从根本上消除所有 mangle.
  //
  // 额外: 保留 msg log (最近 30 条) 用于诊断.

  const MATH_STORE = new Map();  // id → { mode: 'inline'|'display', src: '<raw TeX>' }
  let __mathIdCounter = 0;
  const MATH_PLACEHOLDER_PREFIX = '§§CEMATH';
  const MATH_PLACEHOLDER_SUFFIX = '§§';

  // 保护 raw markdown 里的数学块: 返回占位符替换后的文本
  function protectMathInMarkdown(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = text;
    // $$...$$ 先替换 (display) — 非贪婪, 跨行允许
    out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, src) => {
      const id = ++__mathIdCounter;
      MATH_STORE.set(id, { mode: 'display', src });
      return MATH_PLACEHOLDER_PREFIX + id + MATH_PLACEHOLDER_SUFFIX;
    });
    // $...$ (inline) — 不跨行, 不夸 $, 长度合理
    // 避开数字货币 "$100" 这类情况: 内容不能纯数字
    out = out.replace(/\$([^$\n]{1,400}?)\$/g, (match, src) => {
      // 跳过纯数字/货币: $5, $100, $1,000 等
      if (/^\s*\d[\d.,\s]*\s*$/.test(src)) return match;
      const id = ++__mathIdCounter;
      MATH_STORE.set(id, { mode: 'inline', src });
      return MATH_PLACEHOLDER_PREFIX + id + MATH_PLACEHOLDER_SUFFIX;
    });
    // \(...\) 和 \[...\] 也保护 (部分 AI 会这么写)
    out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, src) => {
      const id = ++__mathIdCounter;
      MATH_STORE.set(id, { mode: 'inline', src });
      return MATH_PLACEHOLDER_PREFIX + id + MATH_PLACEHOLDER_SUFFIX;
    });
    out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, src) => {
      const id = ++__mathIdCounter;
      MATH_STORE.set(id, { mode: 'display', src });
      return MATH_PLACEHOLDER_PREFIX + id + MATH_PLACEHOLDER_SUFFIX;
    });
    return out;
  }

  // 递归处理 content (可能是 string 或 block 数组)
  function protectContentInPlace(content) {
    if (typeof content === 'string') return protectMathInMarkdown(content);
    if (!Array.isArray(content)) return content;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        block.text = protectMathInMarkdown(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        block.thinking = protectMathInMarkdown(block.thinking);
      }
    }
    return content;
  }

  // 处理单条 message 对象 ({role, content}) 或 msg entry ({type, message})
  function protectMessageEntry(entry) {
    if (!entry || typeof entry !== 'object') return;
    // entry 本身可能是 {role, content} 形式或 {type, message: {role, content}} 形式
    const m = entry.message || entry;
    if (!m || typeof m !== 'object') return;
    if (m.content !== undefined) {
      const r = protectContentInPlace(m.content);
      if (typeof r === 'string') m.content = r;
    }
  }

  // 根据 payload 类型决定处理哪些字段
  function protectPayload(payload) {
    if (!payload || typeof payload !== 'object') return;

    // get_session_response: payload.response.messages 是一个大数组
    if (payload.type === 'response' && payload.response && payload.response.type === 'get_session_response') {
      const msgs = payload.response.messages;
      if (Array.isArray(msgs)) {
        for (const m of msgs) protectMessageEntry(m);
      }
    }

    // 其他可能含 AI 文本的 payload 类型 (streaming delta 等) — 用通用策略:
    // 扫 response / request 顶层含 messages / message / content 字段
    if (payload.response) {
      const r = payload.response;
      if (Array.isArray(r.messages)) {
        for (const m of r.messages) protectMessageEntry(m);
      }
      if (r.message && typeof r.message === 'object') {
        protectMessageEntry(r.message);
      }
      // 流式文本 delta (尝试常见字段名)
      if (typeof r.text === 'string') r.text = protectMathInMarkdown(r.text);
      if (typeof r.delta === 'string') r.delta = protectMathInMarkdown(r.delta);
      if (r.delta && typeof r.delta === 'object' && typeof r.delta.text === 'string') {
        r.delta.text = protectMathInMarkdown(r.delta.text);
      }
    }
    if (payload.request) {
      const r = payload.request;
      if (Array.isArray(r.messages)) {
        for (const m of r.messages) protectMessageEntry(m);
      }
      if (r.message && typeof r.message === 'object') {
        protectMessageEntry(r.message);
      }
      if (typeof r.text === 'string') r.text = protectMathInMarkdown(r.text);
      if (typeof r.delta === 'string') r.delta = protectMathInMarkdown(r.delta);
    }
  }

  // Msg log for diagnostics (Ctrl+Shift+M export)
  const __enhanceMsgLog = [];
  const __enhanceMsgLogMax = 30;

  // Session 活跃状态跟踪 — 用于 hard reload 前检查是否会中断 AI 流式响应
  // 每当 CC 发 session_states_update 消息就更新这张表
  const __sessionStates = new Map();  // sessionId → state string
  function updateSessionStates(payload) {
    let req = null;
    if (payload && payload.request && payload.request.type === 'session_states_update') req = payload.request;
    if (!req || !Array.isArray(req.sessions)) return;
    __sessionStates.clear();
    for (const s of req.sessions) {
      if (s && s.sessionId) __sessionStates.set(s.sessionId, s.state || 'unknown');
    }
  }
  function isAnySessionActive() {
    for (const [, state] of __sessionStates) {
      // "idle" = 空闲; 其他全部视为活跃 (processing / streaming / waiting / etc.)
      if (state && state !== 'idle') return { active: true, state };
    }
    return { active: false };
  }
  window.__enhanceSessionStates = __sessionStates;

  try {
    window.addEventListener('message', function __enhanceCaptureListener(ev) {
      if (!ev || !ev.data) return;
      if (ev.data.type !== 'from-extension') return;
      try {
        const payload = ev.data.message;
        // 先记录原始 (深拷贝) 用于诊断
        try {
          __enhanceMsgLog.push({
            t: new Date().toISOString(),
            msg: JSON.parse(JSON.stringify(payload)),
          });
          while (__enhanceMsgLog.length > __enhanceMsgLogMax) __enhanceMsgLog.shift();
        } catch (_) {}
        // 跟踪 session 活跃状态 (用于 hard reload 前的保护)
        updateSessionStates(payload);
        // 然后原地 mutate: 把 $...$ 和 $$...$$ 替换为占位符
        protectPayload(payload);
      } catch (e) {
        console.error('[Claude Enhance] protectPayload error:', e);
      }
    }, true);  // capture = true — 先于 CC 的 bubble listener
    console.log('[Claude Enhance] Capture-phase math protection installed');
  } catch (e) {
    console.error('[Claude Enhance] Failed to install capture hook:', e);
  }
  // Expose for debugging
  window.__enhanceMsgLog = __enhanceMsgLog;
  window.__enhanceMathStore = MATH_STORE;

  // KaTeX 宏表 — 所有 katex.renderToString 调用共享
  // 两类: (1) siunitx 风格单位宏, (2) 常见 LaTeX 包命令的 KaTeX 别名
  //       (KaTeX 只支持核心 LaTeX 语法, 其他包的命令需要手工桥接)
  const SIUNITX_MACROS = {
    // ----- 常见 LaTeX 包 → KaTeX 原生映射 (KaTeX 不支持这些包, 必须桥接) -----
    "\\bm": "\\boldsymbol{#1}",           // bm 包  →  \boldsymbol
    "\\vb": "\\mathbf{#1}",               // physics: vector bold
    "\\dv": "\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}",  // physics: derivative
    "\\pdv": "\\frac{\\partial #1}{\\partial #2}",   // physics: partial derivative
    "\\abs": "\\left|#1\\right|",         // physics
    "\\norm": "\\left\\|#1\\right\\|",    // physics
    "\\bra": "\\left\\langle #1\\right|", // braket
    "\\ket": "\\left|#1\\right\\rangle",  // braket
    "\\braket": "\\left\\langle #1\\right\\rangle",
    // ----- siunitx -----
    // \SI{value}{unit}  \si{unit}  \num{value}
    "\\SI": "#1\\,#2",
    "\\si": "#1",
    "\\num": "#1",
    // SI 前缀
    "\\yotta": "\\text{Y}", "\\zetta": "\\text{Z}",
    "\\exa": "\\text{E}", "\\peta": "\\text{P}",
    "\\tera": "\\text{T}", "\\giga": "\\text{G}",
    "\\mega": "\\text{M}", "\\kilo": "\\text{k}",
    "\\hecto": "\\text{h}", "\\deca": "\\text{da}",
    "\\deci": "\\text{d}", "\\centi": "\\text{c}",
    "\\milli": "\\text{m}", "\\micro": "\\text{μ}",
    "\\nano": "\\text{n}", "\\pico": "\\text{p}",
    "\\femto": "\\text{f}", "\\atto": "\\text{a}",
    // SI 基本单位
    "\\meter": "\\text{m}", "\\metre": "\\text{m}",
    "\\gram": "\\text{g}", "\\kilogram": "\\text{kg}",
    "\\second": "\\text{s}", "\\ampere": "\\text{A}",
    "\\kelvin": "\\text{K}", "\\mole": "\\text{mol}",
    "\\candela": "\\text{cd}",
    // 导出单位
    "\\pascal": "\\text{Pa}", "\\newton": "\\text{N}",
    "\\joule": "\\text{J}", "\\watt": "\\text{W}",
    "\\volt": "\\text{V}", "\\ohm": "\\text{Ω}",
    "\\siemens": "\\text{S}", "\\farad": "\\text{F}",
    "\\henry": "\\text{H}", "\\tesla": "\\text{T}",
    "\\weber": "\\text{Wb}", "\\hertz": "\\text{Hz}",
    "\\lumen": "\\text{lm}", "\\lux": "\\text{lx}",
    "\\becquerel": "\\text{Bq}", "\\gray": "\\text{Gy}",
    "\\sievert": "\\text{Sv}", "\\katal": "\\text{kat}",
    // 非 SI 通用单位
    "\\liter": "\\text{L}", "\\litre": "\\text{L}",
    "\\minute": "\\text{min}", "\\hour": "\\text{h}",
    "\\day": "\\text{d}", "\\electronvolt": "\\text{eV}",
    // 修饰符
    "\\per": "/", "\\cubic": "^{3}",
    "\\squared": "^{2}", "\\cubed": "^{3}",
    // NOT defined (冲突 KaTeX 原生命名, 若强行定义会破坏标准用法):
    //   \bar    — KaTeX 内置重音 (X̄), 不要重定义为 siunitx 的 bar 压强单位
    //   \square — KaTeX 内置空心方符号 □, 不要重定义为平方 ^2
    //   \degree — KaTeX 内置 ° 符号, 不要重定义为 ^\circ
    // 若确实要 siunitx 单位, 用 \text{bar} / \mathrm{bar} / ^{\circ} 明示.
  };

  // ========================================================================
  // 数学归一化管道 — 所有 KaTeX 入口共用 normalizeMathSource()
  //   验证见 webview/test-normalize.js (TDD: 12/12 golden cases passing)
  // ========================================================================

  // 已知的 LaTeX 数学命令白名单 (按类别组织, 无序)
  const MATH_CMD_LIST = [
    // 关系/大运算
    'frac','sqrt','sum','prod','int','oint','iint','iiint','lim','inf','sup','max','min',
    'neq','leq','geq','ll','gg','approx','equiv','sim','simeq','cong','propto',
    'subset','supset','subseteq','supseteq','in','notin','cup','cap','setminus',
    // 二元运算
    'cdot','cdots','ldots','dots','vdots','ddots',
    'times','div','pm','mp','oplus','ominus','otimes','odot','wedge','vee',
    // 箭头
    'to','rightarrow','leftarrow','Rightarrow','Leftarrow','leftrightarrow','Leftrightarrow','mapsto',
    // 微积分/量词
    'partial','nabla','infty','forall','exists','emptyset',
    // 字体
    'text','mathrm','mathbf','mathit','mathsf','mathtt','mathcal','mathbb','mathfrak','boldsymbol','bm','operatorname',
    // 分数/堆叠
    'tfrac','dfrac','cfrac','binom','tbinom','dbinom','overset','underset','stackrel',
    // 定界符
    'Big','big','Bigg','bigg','left','right','middle','langle','rangle','lvert','rvert','lVert','rVert',
    // 函数
    'sin','cos','tan','cot','sec','csc','arcsin','arccos','arctan','sinh','cosh','tanh',
    'log','ln','exp','det','dim','deg','gcd','arg','Re','Im','ker','hom',
    // 小写希腊
    'alpha','beta','gamma','delta','epsilon','varepsilon','zeta','eta','theta','vartheta',
    'iota','kappa','lambda','mu','nu','xi','pi','varpi','rho','varrho','sigma','varsigma',
    'tau','upsilon','phi','varphi','chi','psi','omega',
    // 大写希腊
    'Gamma','Delta','Theta','Lambda','Xi','Pi','Sigma','Upsilon','Phi','Psi','Omega',
    // 命名空格
    'quad','qquad',
    // 重音/装饰
    'hat','bar','tilde','vec','dot','ddot','check','breve','acute','grave',
    'widehat','widetilde','overline','underline','overbrace','underbrace',
    'overrightarrow','overleftarrow',
    // 其他
    'not','prime','dag','ddag','star','ast','circ','bullet',
  ];
  // Subscript-label commands: 后接 eval-bar `|` 当作下标标签的, LEAD_PIPE_RE 不处理, 留给 restoreMissingSubscript
  const LABEL_CMDS = ['text','mathrm','mathbf','mathit','mathsf','mathtt'];
  const NON_LABEL_CMDS = MATH_CMD_LIST.filter(c => !LABEL_CMDS.includes(c));
  const BARE_CMD_RE = new RegExp(
    '(?<![\\\\a-zA-Z])(' + MATH_CMD_LIST.join('|') + ')(?![a-zA-Z])',
    'g'
  );
  const LEAD_PIPE_RE = new RegExp(
    '(?<![A-Za-z0-9])\\|(' + NON_LABEL_CMDS.join('|') + ')(?![a-zA-Z])',
    'g'
  );

  // (1) Unicode → LaTeX: \Delta, \nu, \neq 等
  //     多字符替换后如果紧跟字母, 插入空格 (\DeltaE → \Delta E)
  function normalizeUnicode(tex) {
    const M = {
      'α':'\\alpha','β':'\\beta','γ':'\\gamma','δ':'\\delta',
      'ε':'\\epsilon','ζ':'\\zeta','η':'\\eta','θ':'\\theta',
      'ι':'\\iota','κ':'\\kappa','λ':'\\lambda','μ':'\\mu',
      'ν':'\\nu','ξ':'\\xi','π':'\\pi','ρ':'\\rho',
      'σ':'\\sigma','τ':'\\tau','υ':'\\upsilon','φ':'\\varphi',
      'χ':'\\chi','ψ':'\\psi','ω':'\\omega',
      'Γ':'\\Gamma','Δ':'\\Delta','Θ':'\\Theta','Λ':'\\Lambda',
      'Ξ':'\\Xi','Π':'\\Pi','Σ':'\\Sigma','Υ':'\\Upsilon',
      'Φ':'\\Phi','Ψ':'\\Psi','Ω':'\\Omega',
      '−':'-','–':'-','×':'\\times','÷':'\\div',
      '≤':'\\leq','≥':'\\geq','≠':'\\neq','≈':'\\approx',
      '∞':'\\infty','∂':'\\partial','∇':'\\nabla',
      '∑':'\\sum','∏':'\\prod','∫':'\\int',
      '√':'\\sqrt','±':'\\pm','∓':'\\mp','·':'\\cdot',
      '→':'\\rightarrow','←':'\\leftarrow','↔':'\\leftrightarrow',
      '⇒':'\\Rightarrow','⇐':'\\Leftarrow','⇔':'\\Leftrightarrow',
      '∈':'\\in','∉':'\\notin','⊂':'\\subset','⊃':'\\supset',
      '∪':'\\cup','∩':'\\cap','∅':'\\emptyset',
      '′':"'",'″':"''",
    };
    let out = '';
    for (let i = 0; i < tex.length; i++) {
      const ch = tex[i];
      const rep = M[ch];
      if (rep === undefined) { out += ch; continue; }
      if (rep.startsWith('\\') && i + 1 < tex.length && /[a-zA-Z]/.test(tex[i + 1])) {
        out += rep + ' ';
      } else {
        out += rep;
      }
    }
    return out;
  }

  // (2) 恢复缺失反斜杠:
  //     - 错位为 | 的 \cmd (|cmd 前非字母数字, 且 cmd 不是 label) → \cmd
  //     - 裸 cmd (前非 \ 或字母) → \cmd
  function restoreMissingBackslashes(tex) {
    tex = tex.replace(LEAD_PIPE_RE, '\\$1');
    tex = tex.replace(BARE_CMD_RE, '\\$1');
    return tex;
  }

  // (2.5) CC markdown 有时把 \, \; \! \: 的反斜杠双写成 \\,  \\;  \\!  \\:
  //       KaTeX 把 \\ 当作换行符, 导致视觉断行 + 字面标点出现
  //       修复: \\X → \X  (X ∈ {, ; ! :})  — 矩阵/align 里合法 \\ 换行不动
  function stripEscapedBackslashPunct(tex) {
    return tex.replace(/\\\\([,;!:])/g, '\\$1');
  }

  // 零参数数学符号 — 若后面直接跟 {letters}, 几乎一定是下标 _{letters} 被吞
  // 不包括 \text/\mathrm/\frac 等取 {arg} 的函数命令
  const ZERO_ARG_SYMBOLS = [
    'alpha','beta','gamma','delta','epsilon','varepsilon','zeta','eta','theta','vartheta',
    'iota','kappa','lambda','mu','nu','xi','pi','varpi','rho','varrho','sigma','varsigma',
    'tau','upsilon','phi','varphi','chi','psi','omega',
    'Gamma','Delta','Theta','Lambda','Xi','Pi','Sigma','Upsilon','Phi','Psi','Omega',
    'partial','nabla','infty',
  ];
  const ZERO_ARG_SUB_RE = new RegExp(
    '(\\\\(?:' + ZERO_ARG_SYMBOLS.join('|') + '))\\s*\\{([^{}\\\\]{1,20})\\}',
    'g'
  );

  // (3) 恢复缺失的 _ 下标
  function restoreMissingSubscript(tex) {
    // A. 定界符 | 后直接接 { 或字母/命令 → _
    //    \Big|{X} → \Big|_{X}
    //    \bigg|P  → \bigg|_P   (envelope theorem 等场景)
    tex = tex.replace(/(\\(?:[Bb]ig{1,2}|left|right)\s*\|)\{/g, '$1_{');
    tex = tex.replace(/(\\(?:[Bb]ig{1,2}|left|right)\s*\|)(?=[A-Za-z\\])/g, '$1_');
    // A2. 零参数数学符号后直接跟 {letters}: 几乎一定是下标被吞
    //     \varepsilon{yy} → \varepsilon_{yy}
    tex = tex.replace(ZERO_ARG_SUB_RE, '$1_{$2}');
    // A3. 大运算符后直接跟 {group}: 必是下标 _ 被吞
    //     \sum{k=1}^{N} → \sum_{k=1}^{N}
    tex = tex.replace(
      /(\\(?:sum|prod|int|oint|iint|iiint|coprod|bigcup|bigcap|bigoplus|bigotimes|lim|inf|sup|max|min))\s*\{/g,
      '$1_{'
    );
    // A4. 粗体/花体 {X} 后直接跟单字母 → {X}_letter
    //     \mathbf{C}k → \mathbf{C}_k  \mathcal{O}n → \mathcal{O}_n
    //     仅对数学变量字体: mathbf/mathcal/mathbb/mathfrak/bm/boldsymbol
    //     不含 \text/\mathrm/\mathsf/\mathtt/\mathit (会误伤 \mathrm{d}x 微分等)
    tex = tex.replace(
      /(\\(?:mathbf|mathcal|mathbb|mathfrak|bm|boldsymbol)\{[^{}]+\})([A-Za-z])(?![A-Za-z])/g,
      '$1_$2'
    );
    // B. 大运算符后直接接 \text/\mathrm{MULTI-CHAR} → 加 _
    //    \int\text{top} → \int_\text{top}
    //    但 \int \mathrm{d}x (微分 d) 不改 — 所以 require arg 长度 ≥ 2
    tex = tex.replace(
      /(\\(?:int|oint|iint|iiint|sum|prod|coprod|bigcup|bigcap|bigoplus|bigotimes))\s*(\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt))\{([^{}]{2,})\}/g,
      '$1_$2{$3}'
    );
    // C. 变量/闭括号后 |\text/\mathrm → |_\text  (eval-bar 下标)
    //    \mathbf{u}|\text{prescribed} → \mathbf{u}|_\text{prescribed}
    tex = tex.replace(
      /([A-Za-z}\)\]])\|\s*(\\(?:text|mathrm|mathbf|mathit))\b/g,
      '$1|_$2'
    );
    return tex;
  }

  // (4) 恢复被 CommonMark 吞掉的间距命令: \, \; \: \!
  //     全部规则加 (?<!\\) 防止在已经是 \, / \; 的字符上再加一层反斜杠
  function restoreMathSpacing(tex) {
    // , → \,
    tex = tex.replace(/(?<!\\),(?=\\[a-zA-Z])/g, '\\,');
    // }/)/] 后的 , + 字母/命令/开括号 → \,
    tex = tex.replace(/([})\]])(?<!\\\\)(,)(?=\s*[A-Za-z\\([])/g, '$1\\,');
    // ; → \;
    tex = tex.replace(/(?<!\\);(?=\\[a-zA-Z])/g, '\\;');
    tex = tex.replace(/(?<!\\);(?=\s*=)/g, '\\;');
    tex = tex.replace(/(?<==\s*)(?<!\\);/g, '\\;');
    tex = tex.replace(/([})\]])(?<!\\\\)(;)(?=\s*[A-Za-z\\([])/g, '$1\\;');
    // 组边界: \boxed{\;...\;} 的 \; 被吞成 {;...;} 的模式
    tex = tex.replace(/(?<=\{)(?<!\\\{)\s*(?<!\\);/g, '\\;');
    tex = tex.replace(/(?<!\\);(?=\s*\})/g, '\\;');
    // : → \:
    tex = tex.replace(/(?<!\\):(?=\\[a-zA-Z])/g, '\\:');
    // ! → \!  (避开阶乘 n!)
    tex = tex.replace(/(?<![\\a-zA-Z0-9])!(?=:)/g, '\\!');
    tex = tex.replace(/(?<=:)(?<!\\)!(?![a-zA-Z0-9])/g, '\\!');
    tex = tex.replace(/(?<!\\)!(?=\\[a-zA-Z])/g, '\\!');
    return tex;
  }

  // **统一入口** — 所有 KaTeX 渲染路径调用本函数归一化数学源
  function normalizeMathSource(tex) {
    tex = stripEscapedBackslashPunct(tex);  // FIRST: 恢复被双写的 \,  \;  \!  \:
    tex = normalizeUnicode(tex);
    tex = restoreMissingBackslashes(tex);
    tex = restoreMissingSubscript(tex);
    tex = restoreMathSpacing(tex);
    return tex;
  }

  // ========================================================================
  // 作用域控制: 只处理 AI 聊天消息正文, 绝不碰 Monaco/toolUse/输入框
  // ========================================================================
  const MATH_ALLOW_SELECTOR = '[class*="timelineMessage"]';
  const MATH_DENY_SELECTOR = [
    '.monaco-editor',
    '.monaco-diff-editor',
    '.diffEditorContainer_s6OFow',
    '.diffEditorWrapper_s6OFow',
    '.view-lines',
    '.view-line',
    'pre',
    'code',
    'textarea',
    'input',
    'button',
    '[class*="toolUse"]',
    '[class*="toolResult"]',
    '[class*="toolBody"]',
    '[class*="toolSummary"]',
    '[class*="codeBlock"]',
    '[class*="inputContainer"]',
    '[class*="messageInput"]',
    '[class*="mentionMirror"]',
    '[class*="sessionsList"]',
    '[class*="sessionItem"]',
    '.katex',
  ].join(', ');
  // 同上, 但不含 .katex (Pass 2 要进入 .katex 节点自身)
  const MATH_DENY_SELECTOR_NO_KATEX = MATH_DENY_SELECTOR.replace(/, \.katex$/, '');

  // ========================================================================
  // DOM 辅助
  // ========================================================================

  // 在 container 内查找 openDelim ... closeDelim 对应的 DOM Range
  // 可跨多个文本节点 (例如被 <br> 或 <p> 分隔的多行 $$...$$)
  function findDelimitedRange(container, openDelim, closeDelim) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest(MATH_DENY_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let openNode = null, openOffset = -1;
    let n;
    while (n = walker.nextNode()) {
      const t = n.textContent;
      if (openNode === null) {
        const idx = t.indexOf(openDelim);
        if (idx === -1) continue;
        openNode = n; openOffset = idx;
        const closeIdx = t.indexOf(closeDelim, openOffset + openDelim.length);
        if (closeIdx !== -1) {
          const range = document.createRange();
          range.setStart(openNode, openOffset);
          range.setEnd(n, closeIdx + closeDelim.length);
          return range;
        }
      } else {
        const idx = t.indexOf(closeDelim);
        if (idx !== -1) {
          const range = document.createRange();
          range.setStart(openNode, openOffset);
          range.setEnd(n, idx + closeDelim.length);
          return range;
        }
      }
    }
    return null;
  }

  // 跨节点 $$...$$ 根源修复: markdown pipeline 把多行公式拆成多段 + 吞反斜杠时的系统恢复层
  // ========================================================================
  // Phase 2: swap `§§CEMATH<id>§§` placeholders in DOM with real KaTeX output
  // ========================================================================
  // 占位符由 capture-phase hook 在 markdown 被 CC 的 marked 处理之前注入.
  // 到 DOM 里时, 占位符是 plain text, 没经历过任何 mangle. 我们从 MATH_STORE
  // 里拿原始 TeX 源码, 用 KaTeX 渲染, 把占位符文本节点替换成 KaTeX HTML.
  const PLACEHOLDER_RE = /§§CEMATH(\d+)§§/g;
  let __phRenderedCount = 0;
  function renderMathPlaceholders() {
    if (typeof katex === 'undefined') return;
    if (MATH_STORE.size === 0) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const t = n.textContent;
        if (!t || t.indexOf('§§CEMATH') === -1) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        // 跳过 Monaco/toolUse/input 等; 但 allow 在 timelineMessage 外部的占位符
        // (CC 可能把消息渲染到非 timelineMessage 结构里)
        if (p.closest('.monaco-editor, .monaco-diff-editor, .view-lines, .view-line, script, style')) return NodeFilter.FILTER_REJECT;
        if (p.closest('textarea, input')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let n;
    while (n = walker.nextNode()) nodes.push(n);

    for (const textNode of nodes) {
      const text = textNode.textContent;
      // 分段, 每个占位符替换成 KaTeX span
      const parts = text.split(PLACEHOLDER_RE);
      // parts: ['before', 'id1', 'middle', 'id2', 'after', ...]
      if (parts.length < 3) continue;  // no match
      const frag = document.createDocumentFragment();
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
          // Plain text chunk
          if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
        } else {
          // Placeholder id
          const id = Number(parts[i]);
          const entry = MATH_STORE.get(id);
          if (!entry) {
            // 找不到源 — 保留原占位符文本
            frag.appendChild(document.createTextNode(MATH_PLACEHOLDER_PREFIX + parts[i] + MATH_PLACEHOLDER_SUFFIX));
            continue;
          }
          try {
            const html = katex.renderToString(entry.src, {
              displayMode: entry.mode === 'display',
              throwOnError: false,
              macros: SIUNITX_MACROS,
            });
            const wrapper = document.createElement(entry.mode === 'display' ? 'span' : 'span');
            wrapper.innerHTML = html;
            const rendered = wrapper.firstChild || wrapper;
            frag.appendChild(rendered);
            __phRenderedCount++;
          } catch (e) {
            // 渲染失败: 回退显示原始 TeX 源码 (带 $ $ 包裹)
            const fallback = entry.mode === 'display'
              ? '\n$$' + entry.src + '$$\n'
              : '$' + entry.src + '$';
            frag.appendChild(document.createTextNode(fallback));
          }
        }
      }
      try {
        textNode.parentNode.replaceChild(frag, textNode);
      } catch (_) {}
    }
  }

  function renderBlockDisplayMath() {
    if (typeof katex === 'undefined') return;
    const blocks = document.querySelectorAll(MATH_ALLOW_SELECTOR + ' :where(p, li)');
    let repairedCount = 0;
    blocks.forEach((block) => {
      if (block.dataset.claudeBlockMath) return;
      if (block.closest(MATH_DENY_SELECTOR_NO_KATEX)) return;

      const text = block.textContent;
      if (!text || text.indexOf('$$') === -1) return;
      if (!/\$\$[\s\S]+?\$\$/.test(text)) return;

      block.dataset.claudeBlockMath = '1';
      for (let iter = 0; iter < 10; iter++) {
        const range = findDelimitedRange(block, '$$', '$$');
        if (!range) break;
        try {
          const raw = range.toString();
          let formula = raw.replace(/^\$\$/, '').replace(/\$\$$/, '').trim();
          if (!formula) break;
          formula = normalizeMathSource(formula);
          const html = katex.renderToString(formula, {
            displayMode: true, throwOnError: false, macros: SIUNITX_MACROS,
          });
          const wrapper = document.createElement('span');
          wrapper.innerHTML = html;
          const newNode = wrapper.firstChild || wrapper;
          range.deleteContents();
          range.insertNode(newNode);
          repairedCount++;
        } catch (e) {
          console.warn('[Claude Enhance] Block math render failed:', e);
          break;
        }
      }
    });
    if (repairedCount > 0) {
      console.log(`[Claude Enhance] Block display math: recovered ${repairedCount} formula(s)`);
    }
  }

  console.log('[Claude Enhance] Loading...');

  // 注入样式
  function injectStyles() {
    const styleId = 'claude-enhance-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      /* 代码块字体 */
      pre code, .hljs {
        font-family: 'JetBrains Mono NL', 'LXGW WenKai GB Screen R', 'Consolas', 'Monaco', 'Ubuntu Mono', 'Source Code Pro', 'Fira Code', 'DejaVu Sans Mono', 'Courier New', monospace !important;
      }

      /* KaTeX 样式 */
      .katex {
        font-size: 1.1em;
        /* 防止行内公式在窄容器 (如表格单元格) 里换行 */
        white-space: nowrap;
      }
      .katex-display {
        margin: 1em 0;
        overflow-x: auto;
      }
      /* 表格里的 display 公式: 不要打断单元格内容流
         \[...\] 或 $$...$$ 写在 table cell 里, 默认 block-level 会占满整行,
         把后面紧跟的文本挤到下一行. 这里强制 inline-block 保持流. */
      table .katex-display,
      td .katex-display,
      th .katex-display {
        display: inline-block !important;
        margin: 0 !important;
        padding: 0 !important;
        vertical-align: middle;
        text-align: left;
      }
      table .katex-display > .katex {
        display: inline-block;
        text-align: left;
      }

      /* 列表样式 - 修复数字被截断 */
      ol, ul {
        padding-left: 2em !important;
        list-style-position: outside !important;
      }
      ol {
        list-style-type: decimal !important;
      }

      /* 表格样式 - 暗色主题 */
      table {
        border-collapse: separate;
        border-spacing: 0;
        width: 100%;
        margin: 1em 0;
        font-size: 0.95em;
        color: #e0e0e0;
        border-radius: 4px;
        overflow: hidden;
        border: 3px solid #707070;
      }
      table thead {
        background: linear-gradient(to bottom, #2d2d2d, #252525);
      }
      table th {
        padding: 10px 14px;
        text-align: left;
        font-weight: 600;
        border: 3px solid #707070;
        color: #ffffff;
      }
      table th:first-child {
        border-top-left-radius: 4px;
      }
      table th:last-child {
        border-top-right-radius: 4px;
      }
      table td {
        padding: 10px 14px;
        border: 3px solid #707070;
        border-top: none;
        border-left: none;
      }
      table td:last-child {
        border-right: none;
      }
      table tbody tr:last-child td:first-child {
        border-bottom-left-radius: 4px;
      }
      table tbody tr:last-child td:last-child {
        border-bottom-right-radius: 4px;
      }
      table tbody tr:nth-child(even) {
        background-color: rgba(255, 255, 255, 0.03);
      }
      table tbody tr:hover {
        background-color: rgba(255, 255, 255, 0.08);
      }

      /* 代码块换行 */
      pre {
        white-space: pre-wrap !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
        max-width: 100% !important;
      }
      pre code {
        white-space: pre-wrap !important;
        word-break: break-word !important;
      }

      /* AI 消息复制按钮样式 */
      .claude-copy-btn {
        position: absolute;
        bottom: 8px;
        right: 8px;
        background: rgba(60, 60, 60, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: #e0e0e0;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.2s, background 0.2s;
        z-index: 100;
      }
      .claude-copy-btn:hover {
        background: rgba(80, 80, 80, 0.95);
        color: #fff;
      }
      .claude-copy-btn.copied {
        background: rgba(74, 222, 128, 0.9);
        color: #000;
      }
      [class*="timelineMessage"]:hover .claude-copy-btn {
        opacity: 1;
      }
      [class*="timelineMessage"] {
        position: relative;
      }
    `;
    document.head.appendChild(style);
  }

  // 注入 Highlight.js
  function injectHighlightJS() {
    if (window.hljsLoaded) return;

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css';
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
    script.onload = () => {
      console.log('[Claude Enhance] Highlight.js loaded');
      window.hljsLoaded = true;
      highlightAllCode();
    };
    document.head.appendChild(script);
  }

  // 注入 KaTeX
  function injectKaTeX() {
    if (window.katexLoaded) return;

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css';
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js';
    script.onload = () => {
      // 等待 katex 挂载到 window
      const checkKatex = () => {
        if (typeof katex !== 'undefined') {
          window.katexLoaded = true;
          console.log('[Claude Enhance] KaTeX ready:', typeof katex);
        } else {
          console.log('[Claude Enhance] KaTeX not on window, retrying...');
          setTimeout(checkKatex, 100);
        }
      };
      checkKatex();
    };
    script.onerror = (e) => {
      console.error('[Claude Enhance] KaTeX load error:', e);
    };
    document.head.appendChild(script);
  }

  // 高亮代码块
  function highlightAllCode() {
    if (typeof hljs === 'undefined') return;

    document.querySelectorAll('pre code').forEach((block) => {
      if (block.classList.contains('language-latex')) return;
      if (!block.classList.contains('hljs')) {
        hljs.highlightElement(block);
      }
    });
  }

  // 修复 CC 原生 KaTeX 渲染后的公式 (Pass 1 硬错误 / Pass 2 annotation 源检查)
  // 所有归一化都走模块级 normalizeMathSource, 和其他入口保持一致
  function repairKatexErrors() {
    if (typeof katex === 'undefined') return;

    // 先用 throwOnError:true 严格尝试, 失败则用 throwOnError:false 做 best-effort 渲染
    // 目的: 归一化后的源通常比原始 mangled 源更正确, 尽量用上归一化结果
    function rerender(targetNode, source, isDisplay) {
      let rendered;
      try {
        rendered = katex.renderToString(source, {
          displayMode: isDisplay, throwOnError: true, macros: SIUNITX_MACROS,
        });
      } catch (e) {
        try {
          rendered = katex.renderToString(source, {
            displayMode: isDisplay, throwOnError: false, macros: SIUNITX_MACROS,
          });
        } catch (e2) { return false; }
      }
      const wrapper = document.createElement(isDisplay ? 'div' : 'span');
      wrapper.innerHTML = rendered;
      const newNode = wrapper.firstChild || wrapper;
      if (newNode.nodeType === 1) newNode.setAttribute('data-claude-repaired', '1');
      targetNode.replaceWith(newNode);
      return true;
    }

    // Pass 1: 硬错误 (.katex-error) — CC 原生 KaTeX 完全挂了
    document.querySelectorAll(MATH_ALLOW_SELECTOR + ' .katex-error').forEach((errSpan) => {
      if (errSpan.closest(MATH_DENY_SELECTOR_NO_KATEX)) return;
      const rawTex = errSpan.textContent;
      if (!rawTex || rawTex.length > 5000) return;
      const katexRoot = errSpan.closest('.katex');
      if (!katexRoot) return;
      if (katexRoot.closest('[data-claude-repaired]')) return;
      const isDisplay = !!katexRoot.closest('.katex-display');
      const target = isDisplay ? (katexRoot.closest('.katex-display') || katexRoot) : katexRoot;
      rerender(target, normalizeMathSource(rawTex), isDisplay);
    });

    // Pass 2: 软错误 — 渲染"成功"但源码里有裸命令或被吞掉的间距符
    let pass2Seen = 0, pass2Changed = 0, pass2Replaced = 0;
    document.querySelectorAll(MATH_ALLOW_SELECTOR + ' .katex').forEach((katexNode) => {
      if (katexNode.closest(MATH_DENY_SELECTOR_NO_KATEX)) return;
      if (katexNode.closest('[data-claude-repaired]')) return;
      const annotation = katexNode.querySelector('annotation');
      if (!annotation) return;
      const source = annotation.textContent;
      if (!source) return;
      // 限制长度: 5000 (之前 800 太紧, 复杂 display 公式很容易超)
      if (source.length > 5000) {
        console.warn('[Claude Enhance] Pass2: skip (source too long)', source.length);
        return;
      }
      pass2Seen++;
      const fixed = normalizeMathSource(source);
      if (fixed === source) return;
      pass2Changed++;
      // 诊断日志 (窗口打开后可在 DevTools 看)
      if (pass2Changed <= 3) {
        console.log('[Claude Enhance] Pass2 #' + pass2Changed);
        console.log('  src :', source.slice(0, 200));
        console.log('  fix :', fixed.slice(0, 200));
      }
      const isDisplay = !!katexNode.closest('.katex-display');
      const target = isDisplay ? (katexNode.closest('.katex-display') || katexNode) : katexNode;
      if (rerender(target, fixed, isDisplay)) pass2Replaced++;
    });
    if (pass2Seen > 0) {
      console.log(`[Claude Enhance] Pass2 summary: ${pass2Seen} scanned, ${pass2Changed} normalized, ${pass2Replaced} replaced`);
    }
  }

  // 渲染 LaTeX
  function renderLaTeX() {
    if (typeof katex === 'undefined') return;
    if (window._claudeRenderingLaTeX) return;
    window._claudeRenderingLaTeX = true;

    try {
      const walker = document.createTreeWalker(
        document.getElementById('root') || document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentNode;
            if (!parent || parent.nodeType !== 1) return NodeFilter.FILTER_REJECT;
            // 只在 AI 消息正文 (timelineMessage) 内部处理
            if (!parent.closest(MATH_ALLOW_SELECTOR)) return NodeFilter.FILTER_REJECT;
            // 排除 Monaco 编辑器 / tool use / 代码块 / 输入框 / 已渲染 KaTeX
            if (parent.closest(MATH_DENY_SELECTOR)) return NodeFilter.FILTER_REJECT;
            const text = node.textContent;
            if (!text) return NodeFilter.FILTER_REJECT;
            // 原始模式: $$, $, \(, \[
            if (text.includes('$$') || text.includes('$') || text.includes('\\(') || text.includes('\\[')) {
              return NodeFilter.FILTER_ACCEPT;
            }
            // CommonMark 转义后的模式: \[ → [, \] → ]
            // 检测 [内含\LaTeX命令] 形如 [\sum_{n=1}...]
            if (/\[[^\[\]]*\\[a-zA-Z]/.test(text)) {
              return NodeFilter.FILTER_ACCEPT;
            }
            // CommonMark 转义后的模式: \( → (, \) → )
            // 检测含有 \LaTeX命令(2+字母, 含\mu \pi等) 的文本节点, 可能来自 \(...\)
            if (/\\[a-zA-Z]{2,}/.test(text)) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_REJECT;
          }
        }
      );

      const nodesToRender = [];
      let node;
      while (node = walker.nextNode()) {
        nodesToRender.push(node);
      }

      nodesToRender.forEach((textNode) => {
        const text = textNode.textContent;
        if (!text || !text.trim()) return;

        try {
          let resultHTML = text;
          let hasFormula = false;

          // $$...$$ 块级公式 (保留换行, 矩阵需要)
          resultHTML = resultHTML.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
            hasFormula = true;
            try {
              let fixed = formula;

              // 修复矩阵换行: 单反斜杠+空格/换行 → 双反斜杠
              fixed = fixed.replace(/\\\s*\n/g, '\\\\\n');
              fixed = fixed.replace(/\\ (?=[a-zA-Z0-9_{}])/g, '\\\\ ');

              // 修复间距命令 \[x] → \\[x]
              fixed = fixed.replace(/\\\[(\d+(?:\.\d+)?[a-z]*)\]/gi, '\\\\[$1]');

              // 修复 cases 环境中的间距
              fixed = fixed.replace(/&\s*\\\[6pt\]/g, '& \\\\');

              // 修复常见语法错误: \sum{...} → \sum_{...}
              fixed = fixed.replace(/\\(sum|prod|int|lim|inf|sup|max|min)\{([^}]+)\}/g, '\\$1_{$2}');

              // 修复 \operatorname 后面直接跟内容的情况
              fixed = fixed.replace(/\\operatorname\{(\w+)\}(\()/g, '\\operatorname{$1}$2');

              // Markdown 吞掉 \! 后的孤立 ! 清理 (同 inline 分支)
              let prev2;
              do {
                prev2 = fixed;
                fixed = fixed.replace(/(\\[a-zA-Z]+)!\s*(?=\\[a-zA-Z])/g, '$1');
              } while (fixed !== prev2);

              return katex.renderToString(normalizeMathSource(fixed), { displayMode: true, throwOnError: false, macros: SIUNITX_MACROS });
            } catch { return match; }
          });

          // \(...\) 行内公式
          resultHTML = resultHTML.replace(/\\\(([\s\S]+?)\\\)/g, (match, formula) => {
            hasFormula = true;
            try {
              return katex.renderToString(normalizeMathSource(formula.trim()), { displayMode: false, throwOnError: false, macros: SIUNITX_MACROS });
            } catch { return match; }
          });

          // \[...\] 块级公式 (保留换行)
          resultHTML = resultHTML.replace(/\\\[([\s\S]+?)\\\]/g, (match, formula) => {
            hasFormula = true;
            try {
              return katex.renderToString(normalizeMathSource(formula), { displayMode: true, throwOnError: false, macros: SIUNITX_MACROS });
            } catch { return match; }
          });

          // $...$ 行内公式 (单行, 不跨 $, 长度上限 400 — 防止贪婪吞噬已渲染HTML)
          resultHTML = resultHTML.replace(/\$([^$\n]{1,400})\$/g, (match, formula) => {
            const content = formula.trim();
            // 清理换行和多余空格, 保持一行
            const cleaned = content.replace(/\s+/g, ' ').trim();
            const looksLikeLatex = cleaned.length <= 2 || cleaned.includes('\\') ||
              cleaned.includes('_') || cleaned.includes('^') || cleaned.includes('{') ||
              /\b(alpha|beta|gamma|delta|theta|lambda|mu|sigma|pi|omega|sum|int|frac|sqrt)\b/i.test(cleaned) ||
              // 单字母变量数学式: 含 = 且无连续小写字母(排除自然语言单词)
              (cleaned.includes('=') && !/[a-z]{2,}/.test(cleaned)) ||
              // 逗号分隔的短变量列表: $C, E$ / $A, B, C$ / $u_0, v_0$
              // 判据: 含逗号 且没有 3+ 连续小写字母 (排除 "hello, world" 这类自然语言)
              (cleaned.includes(',') && !/[a-z]{3,}/.test(cleaned));
            if (!looksLikeLatex) return match;
            hasFormula = true;
            try {
              let fixed = cleaned.replace(/\\ (?=[a-zA-Z0-9_{}])/g, '\\\\ ');
              // Markdown 吞掉 `\!` 负薄空格后留下孤立 `!` (形如 "\cdot!\sigma")
              // 迭代移除两个 TeX 控制序列之间的孤立 `!`, 避免 KaTeX 渲染成字面 `!`
              let prev;
              do {
                prev = fixed;
                fixed = fixed.replace(/(\\[a-zA-Z]+)!\s*(?=\\[a-zA-Z])/g, '$1');
              } while (fixed !== prev);
              return katex.renderToString(normalizeMathSource(fixed), { displayMode: false, throwOnError: false, macros: SIUNITX_MACROS });
            } catch { return match; }
          });

          // 修复 CommonMark 转义: \[...\] 被渲染为 [...] (\[ → [, \] → ])
          // (?<!\w) 防止误匹配 \left[...] 中 t 后面的 [
          resultHTML = resultHTML.replace(/(?<!\w)\[([^\[\]]{3,600})\](?!\w)/g, (match, formula) => {
            const trimmed = formula.trim();
            // 跳过已含 HTML 标签的内容 (前面步骤已渲染的 KaTeX HTML)
            if (/<[a-zA-Z]/.test(trimmed)) return match;
            if (!/\\[a-zA-Z]/.test(trimmed)) return match;
            hasFormula = true;
            try {
              return katex.renderToString(normalizeMathSource(trimmed), { displayMode: true, throwOnError: false, macros: SIUNITX_MACROS });
            } catch { return match; }
          });

          // 修复 CommonMark 转义: \(...\) 被渲染为 (...) (\( → (, \) → ))
          // (?<!\w) 防止误匹配 \left(...) 中 t 后面的 ( 以及 f(x) 等函数调用
          resultHTML = resultHTML.replace(/(?<!\w)\(([^()]*(?:\([^()]*\)[^()]*)*)\)(?!\w)/g, (match, formula) => {
            const trimmed = formula.trim();
            // 跳过已含 HTML 标签的内容: $...$ 步骤已将公式渲染为 KaTeX HTML,
            // MathML annotation 里的 \cmd 和 style 里的 '-' 会误触发此分支,
            // 导致整段 KaTeX HTML 被当作 LaTeX 再次渲染成乱码
            if (/<[a-zA-Z]/.test(trimmed)) return match;
            const cmdCount = (trimmed.match(/\\[a-zA-Z]+/g) || []).length;
            const hasMathOp = /[=+\-^_<>]/.test(trimmed);
            if (cmdCount < 1 || (cmdCount < 2 && !hasMathOp)) return match;
            hasFormula = true;
            try {
              return katex.renderToString(normalizeMathSource(trimmed), { displayMode: false, throwOnError: false, macros: SIUNITX_MACROS });
            } catch { return match; }
          });

          if (hasFormula && resultHTML !== text && resultHTML.includes('katex')) {
            const span = document.createElement('span');
            span.innerHTML = resultHTML;
            textNode.parentNode.replaceChild(span, textNode);
          }
        } catch (e) {}
      });
    } finally {
      window._claudeRenderingLaTeX = false;
    }
  }

  // ========== AI 对话复制功能 ==========

  // 需要排除的类名前缀 (思维链和工具调用)
  const EXCLUDE_PREFIXES = [
    'thinking_',
    'thinkingContent_',
    'thinkingSummary_',
    'toolUse_',
    'toolResult_',
    'toolBody_',
    'toolBodyGrid_',
    'toolBodyRow_',
    'toolSummary_',
    'root_ZUQaOA',
    'userMessage_',
    'userMessageContainer_'
  ];

  // 检查元素是否应该被排除
  function shouldExclude(element) {
    if (!element || !element.className) return false;
    const className = typeof element.className === 'string' ? element.className : '';
    return EXCLUDE_PREFIXES.some(prefix => className.includes(prefix));
  }

  // 从 HTML 元素提取 Markdown 格式内容 (紧凑版)
  function htmlToMarkdown(element) {
    if (!element) return '';

    const IGNORE_TAGS = new Set(['BUTTON', 'STYLE', 'SCRIPT', 'SVG', 'MAT-ICON']);

    function traverse(node, context = {}) {
      // 文本节点
      if (node.nodeType === 3) {
        const text = node.textContent;
        if (context.inPre) return text;
        return text.replace(/\s+/g, ' ');
      }

      // 非元素节点跳过
      if (node.nodeType !== 1) return '';
      if (IGNORE_TAGS.has(node.tagName)) return '';
      if (shouldExclude(node)) return '';

      const tag = node.tagName;
      const children = Array.from(node.childNodes);
      const newContext = {
        ...context,
        inPre: context.inPre || tag === 'PRE',
        inList: context.inList || tag === 'LI',
      };

      // 先递归处理子节点
      const childrenContent = children
        .map(c => traverse(c, newContext))
        .join('');

      // KaTeX 公式处理
      if (tag === 'SPAN' && node.classList?.contains('katex')) {
        const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
        if (annotation) {
          const tex = annotation.textContent;
          // 清理换行和多余空格, 保持单行 (Obsidian 兼容)
          const cleaned = tex.replace(/\s+/g, ' ').trim();
          const isDisplay = node.classList.contains('katex-display');
          return isDisplay ? `$$${cleaned}$$` : `$${cleaned}$`;
        }
      }

      // 根据标签类型返回格式化内容
      switch (tag) {
        case 'H1': return '\n# ' + childrenContent + '\n';
        case 'H2': return '\n## ' + childrenContent + '\n';
        case 'H3': return '\n### ' + childrenContent + '\n';
        case 'H4': return '\n#### ' + childrenContent + '\n';
        case 'H5': return '\n##### ' + childrenContent + '\n';
        case 'H6': return '\n###### ' + childrenContent + '\n';

        case 'P':
          return context.inList ? childrenContent : '\n' + childrenContent.trim() + '\n';

        case 'BR':
          return '\n';

        case 'STRONG':
        case 'B':
          return `**${childrenContent}**`;

        case 'EM':
        case 'I':
          return `*${childrenContent}*`;

        case 'CODE':
          if (context.inPre) return childrenContent;
          return `\`${childrenContent}\``;

        case 'PRE': {
          const codeEl = node.querySelector('code');
          const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
          const content = codeEl ? codeEl.textContent : node.textContent;
          return `\`\`\`${lang}\n${content}\n\`\`\``;
        }

        case 'A': {
          const href = node.getAttribute('href') || '';
          const text = node.textContent;
          return `[${text}](${href})`;
        }

        case 'UL': {
          const items = children
            .filter(c => c.tagName === 'LI')
            .map(li => {
              const text = li.textContent.trim();
              const nested = li.querySelector('ul, ol');
              if (nested) {
                const nestedMd = traverse(nested, {});
                return `- ${text.replace(nested.textContent.trim(), '').trim()}\n  ${nestedMd}`;
              }
              return `- ${text}`;
            })
            .join('\n');
          return '\n' + items + '\n';
        }

        case 'OL': {
          let idx = 1;
          const items = children
            .filter(c => c.tagName === 'LI')
            .map(li => {
              const text = li.textContent.trim();
              return `${idx++}. ${text}`;
            })
            .join('\n');
          return '\n' + items + '\n';
        }

        case 'LI':
          return childrenContent.trim();

        case 'TABLE': {
          const rows = node.querySelectorAll('tr');
          if (rows.length === 0) return '';
          let result = '';
          rows.forEach((row, rowIdx) => {
            const cells = row.querySelectorAll('th, td');
            const cellTexts = Array.from(cells).map(c =>
              c.textContent.trim().replace(/\|/g, '\\|')
            );
            result += `| ${cellTexts.join(' | ')} |\n`;
            if (rowIdx === 0) {
              result += `| ${cellTexts.map(() => '---').join(' | ')} |\n`;
            }
          });
          return '\n' + result.trim() + '\n';
        }

        case 'BLOCKQUOTE': {
          const quoteLines = node.textContent.trim().split('\n');
          return '\n' + quoteLines.map(l => `> ${l}`).join('\n') + '\n';
        }

        case 'HR':
          return '\n\n---\n\n';

        case 'DIV':
        case 'SECTION':
        case 'ARTICLE':
        case 'SPAN':
        default:
          return childrenContent;
      }
    }

    // 执行转换并紧凑化换行
    return traverse(element)
      .replace(/\n{3,}/g, '\n\n')      // 3+ 个换行 → 最多1个空行
      .replace(/^\n+/, '')             // 移除开头换行
      .replace(/\n+$/, '')             // 移除末尾换行
      .replace(/[ \t]+$/gm, '')        // 移除行尾空格
      .trim();
  }

  // 按轮次分组消息
  function groupMessagesByTurn() {
    const container = document.querySelector('[class*="messagesContainer_"]');
    if (!container) return [];

    const turns = [];
    let currentTurn = [];

    for (const child of container.children) {
      const className = child.className || '';

      if (className.includes('userMessage')) {
        if (currentTurn.length > 0) {
          turns.push([...currentTurn]);
          currentTurn = [];
        }
      } else if (className.includes('timelineMessage')) {
        currentTurn.push(child);
      }
    }

    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    return turns;
  }

  // 为消息添加复制按钮
  function addCopyButton(messageEl) {
    if (messageEl.querySelector('.claude-copy-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'claude-copy-btn';
    btn.textContent = '复制';
    btn.title = '复制完整 Markdown 内容 (不含思维链和工具调用)';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();

      // 获取整轮消息
      const turnMessages = messageEl._turnMessages || [messageEl];

      // 合并所有消息的 Markdown 内容
      const contents = turnMessages.map(msg => htmlToMarkdown(msg)).filter(c => c.trim());
      const finalContent = contents.join('\n\n');

      try {
        await navigator.clipboard.writeText(finalContent);
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.classList.remove('copied');
        }, 1500);
      } catch (err) {
        console.error('[Claude Enhance] Copy failed:', err);
        btn.textContent = '失败';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      }
    });

    messageEl.appendChild(btn);
  }

  // 扫描并添加复制按钮 (只在每轮末尾添加)
  function scanAndAddCopyButtons() {
    const turns = groupMessagesByTurn();

    turns.forEach(turnMessages => {
      if (turnMessages.length === 0) return;

      // 只在每轮最后一个消息上添加按钮
      const lastMessage = turnMessages[turnMessages.length - 1];

      // 存储整轮消息的引用
      lastMessage._turnMessages = turnMessages;

      addCopyButton(lastMessage);
    });
  }

  // ========== 滚轮缩放功能 ==========

  function setupZoom() {
    let zoom = parseFloat(localStorage.getItem('claude-zoom') || '1.0');
    document.body.style.zoom = zoom;

    document.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        zoom = Math.max(0.5, Math.min(2.0, zoom + delta));
        document.body.style.zoom = zoom;
        localStorage.setItem('claude-zoom', zoom.toString());
        showZoomIndicator(zoom);
      }
    }, { passive: false });
  }

  function showZoomIndicator(zoom) {
    let indicator = document.getElementById('zoom-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'zoom-indicator';
      indicator.style.cssText = `
        position: fixed; top: 20px; right: 20px;
        background: rgba(40, 40, 40, 0.95); color: #fff;
        padding: 8px 16px; border-radius: 6px; font-size: 14px;
        z-index: 10000; transition: opacity 0.3s;
      `;
      document.body.appendChild(indicator);
    }
    indicator.textContent = `缩放: ${Math.round(zoom * 100)}%`;
    indicator.style.opacity = '1';
    setTimeout(() => { indicator.style.opacity = '0'; }, 1000);
  }

  // DOM 监听 - 防抖处理, 避免输出过程中抽搐
  function setupObserver() {
    let debounceTimer = null;
    const DEBOUNCE_DELAY = 500; // 等待 500ms 无变化后再渲染

    const observer = new MutationObserver((mutations) => {
      // 跳过我们自己添加的元素
      let hasRealChange = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            const cls = node.className?.toString() || '';
            if (!cls.includes('hljs') && !cls.includes('katex') && !cls.includes('zoom-indicator')) {
              hasRealChange = true;
              break;
            }
          }
        }
        if (hasRealChange) break;
      }

      if (!hasRealChange) return;

      // 清除之前的定时器, 重新计时
      if (debounceTimer) clearTimeout(debounceTimer);

      // 等待输出稳定后再渲染
      debounceTimer = setTimeout(() => {
        highlightAllCode();
        renderLaTeX();
        renderMathPlaceholders();  // Phase 2: swap §§CEMATH<id>§§ with KaTeX
        renderBlockDisplayMath();
        repairKatexErrors();
        scanAndAddCopyButtons();
      }, DEBOUNCE_DELAY);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // DOM 探测工具 - 按 Ctrl+Shift+D 导出 DOM 结构
  function setupDOMInspector() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Shift+D 触发 DOM 导出
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        exportDOMStructure();
      }
      // Ctrl+Shift+L 导出页面里所有 KaTeX 公式的 annotation 源 + 归一化结果
      if (e.ctrlKey && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        exportKatexSources();
      }
      // Ctrl+Shift+M 导出捕获的 from-extension 消息流 (Phase 1 诊断)
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        exportMessageLog();
      }
      // Ctrl+Shift+R 强制刷新全部渲染 — 清除所有 "已处理" 标记后重跑全部 pass
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        forceRefreshRendering();
      }
    });
  }

  // 强制刷新 — 软刷新单档版本.
  //   清 flag + 重跑所有 pass. 不调用 window.location.reload(),
  //   因为 VSCode webview 的资源 URL 带一次性 nonce, reload 后所有
  //   asset 引用失效, 整个面板会变白屏.
  //   如果软刷新无法解决(比如 Phase 2 capture-hook 漏接 payload, DOM 已
  //   物理 mangled), 唯一可靠的办法是手动关闭 × 重新打开 Claude Code 面板.
  function forceRefreshRendering() {
    // 1. 清除防重入标记
    document.querySelectorAll('[data-claude-block-math]').forEach(el => {
      try { delete el.dataset.claudeBlockMath; } catch (_) {}
    });
    document.querySelectorAll('[data-claude-repaired]').forEach(el => {
      try { el.removeAttribute('data-claude-repaired'); } catch (_) {}
    });

    // 2. 清除 renderLaTeX 的锁 (防止"正在渲染"状态卡住)
    window._claudeRenderingLaTeX = false;

    // 3. 依次重跑所有增强 pass (和 observer 回调顺序一致)
    let passes = 0;
    try { if (typeof highlightAllCode === 'function') { highlightAllCode(); passes++; } } catch (e) { console.warn('[refresh] hljs:', e); }
    try { if (typeof renderLaTeX === 'function') { renderLaTeX(); passes++; } } catch (e) { console.warn('[refresh] latex:', e); }
    try { if (typeof renderMathPlaceholders === 'function') { renderMathPlaceholders(); passes++; } } catch (e) { console.warn('[refresh] placeholders:', e); }
    try { if (typeof renderBlockDisplayMath === 'function') { renderBlockDisplayMath(); passes++; } } catch (e) { console.warn('[refresh] block display:', e); }
    try { if (typeof repairKatexErrors === 'function') { repairKatexErrors(); passes++; } } catch (e) { console.warn('[refresh] repair:', e); }
    try { if (typeof scanAndAddCopyButtons === 'function') { scanAndAddCopyButtons(); passes++; } } catch (e) { console.warn('[refresh] copy btn:', e); }

    const msgCount = window.__enhanceMsgLog ? window.__enhanceMsgLog.length : 0;
    const mathCount = window.__enhanceMathStore ? window.__enhanceMathStore.size : 0;
    const msg = `刷新完成 (${passes} passes, ${mathCount} 占位符, ${msgCount} 消息). 仍有问题请关闭 × 重开面板`;
    showNotification(msg);
    console.log('[Claude Enhance] ' + msg);
  }

  // Phase 1: 导出 from-extension 消息 payload
  function exportMessageLog() {
    const log = window.__enhanceMsgLog || [];
    const out = JSON.stringify({
      timestamp: new Date().toISOString(),
      count: log.length,
      messages: log,
    }, null, 2);
    navigator.clipboard.writeText(out).then(() => {
      showNotification(`捕获到 ${log.length} 条消息. 粘贴给 Claude 分析 payload 结构.`);
      console.log(`[Claude Enhance] Exported ${log.length} from-extension messages`);
    }).catch(err => {
      console.error('[Claude Enhance] Copy failed:', err);
      console.log(out);
      showNotification('复制失败, 查看控制台');
    });
  }

  // 把所有 .katex 的 <annotation> 源码 + 归一化后的预期源码打包到剪贴板
  function exportKatexSources() {
    const nodes = document.querySelectorAll(MATH_ALLOW_SELECTOR + ' .katex');
    const items = [];
    nodes.forEach((node, i) => {
      if (node.closest(MATH_DENY_SELECTOR_NO_KATEX)) return;
      const annotation = node.querySelector('annotation');
      if (!annotation) return;
      const src = annotation.textContent || '';
      const isDisplay = !!node.closest('.katex-display');
      let fixed = '';
      try { fixed = normalizeMathSource(src); } catch (e) { fixed = '<ERROR: ' + e.message + '>'; }
      items.push({
        i: items.length,
        mode: isDisplay ? 'display' : 'inline',
        srcLen: src.length,
        src: src,
        fixed: fixed,
        changed: fixed !== src,
      });
    });

    // NEW: 导出 timelineMessage 里所有含 $ / \( / \[ 但 *未被 KaTeX 渲染* 的 text node
    // 配合父元素链路, 用来定位为什么 renderLaTeX 漏掉某个公式
    const unrendered = [];
    const msgContainers = document.querySelectorAll(MATH_ALLOW_SELECTOR);
    msgContainers.forEach(container => {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let n;
      while (n = walker.nextNode()) {
        const t = n.textContent;
        if (!t) continue;
        const hasMathMarker = t.includes('$') || t.includes('\\(') || t.includes('\\[');
        const hasBackslashCmd = /\\[a-zA-Z]{2,}/.test(t);
        const hasLikelyMangled = /\|(neq|varepsilon|sigma|delta|frac|text|bm|leq|geq|sum|int)/.test(t);
        if (!hasMathMarker && !hasBackslashCmd && !hasLikelyMangled) continue;
        // Skip if inside .katex (already rendered)
        if (n.parentElement && n.parentElement.closest('.katex')) continue;
        // 构造 parent ancestor chain (上溯 6 层)
        const chain = [];
        let el = n.parentElement;
        for (let k = 0; k < 6 && el; k++) {
          chain.push(el.tagName + (el.className ? '.' + String(el.className).split(/\s+/).slice(0, 3).join('.') : ''));
          el = el.parentElement;
        }
        // Determine if scope filters would reject
        const p = n.parentElement;
        const inScope = p && p.closest(MATH_ALLOW_SELECTOR) && !p.closest(MATH_DENY_SELECTOR);
        unrendered.push({
          i: unrendered.length,
          text: t.length > 300 ? t.slice(0, 300) + '…' : t,
          len: t.length,
          inScope: !!inScope,
          deniedBy: p && p.closest(MATH_DENY_SELECTOR) ? p.closest(MATH_DENY_SELECTOR).className || p.closest(MATH_DENY_SELECTOR).tagName : null,
          parents: chain,
        });
      }
    });

    const out = JSON.stringify({
      timestamp: new Date().toISOString(),
      totalKatex: nodes.length,
      rendered: items.length,
      unrenderedCount: unrendered.length,
      renderedSamples: items.slice(0, 50),
      unrendered: unrendered.slice(0, 50),
    }, null, 2);
    navigator.clipboard.writeText(out).then(() => {
      showNotification(`渲染: ${items.length}, 未渲染但含数学标记: ${unrendered.length}`);
      console.log(`[Claude Enhance] Exported ${items.length} rendered, ${unrendered.length} unrendered math-like texts`);
    }).catch(err => {
      console.error('[Claude Enhance] Copy failed:', err);
      console.log(out);
      showNotification('复制失败, 请查看控制台');
    });
  }

  function exportDOMStructure() {
    console.log('[Claude Enhance] Exporting DOM structure...');

    const result = {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      rootClasses: [],
      messageContainers: [],
      allClassNames: new Set(),
      potentialMessageSelectors: []
    };

    // 收集所有类名
    document.querySelectorAll('*').forEach(el => {
      if (el.className && typeof el.className === 'string') {
        el.className.split(/\s+/).forEach(cls => {
          if (cls) result.allClassNames.add(cls);
        });
      }
    });

    // 查找可能的消息容器 (基于常见模式)
    const messagePatterns = [
      '[class*="message"]', '[class*="Message"]',
      '[class*="chat"]', '[class*="Chat"]',
      '[class*="response"]', '[class*="Response"]',
      '[class*="assistant"]', '[class*="Assistant"]',
      '[class*="human"]', '[class*="Human"]',
      '[class*="user"]', '[class*="User"]',
      '[class*="turn"]', '[class*="Turn"]',
      '[class*="content"]', '[class*="Content"]',
      '[role="article"]', '[role="listitem"]',
      '[data-message]', '[data-turn]'
    ];

    messagePatterns.forEach(selector => {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          result.potentialMessageSelectors.push({
            selector,
            count: elements.length,
            sampleClasses: Array.from(elements).slice(0, 3).map(el => el.className)
          });
        }
      } catch (e) {}
    });

    // 分析 #root 下的结构
    const root = document.getElementById('root');
    if (root) {
      result.rootStructure = analyzeElement(root, 0, 4);
    }

    // 查找包含大量文本的容器
    const textContainers = [];
    document.querySelectorAll('div, section, article').forEach(el => {
      const text = el.innerText || '';
      if (text.length > 200 && text.length < 50000) {
        const children = el.children.length;
        if (children < 50) {
          textContainers.push({
            tag: el.tagName,
            className: el.className,
            textLength: text.length,
            childCount: children,
            preview: text.substring(0, 100) + '...'
          });
        }
      }
    });
    result.textContainers = textContainers.slice(0, 20);

    // 转换 Set 为数组
    result.allClassNames = Array.from(result.allClassNames).sort();

    // 复制到剪贴板
    const output = JSON.stringify(result, null, 2);
    navigator.clipboard.writeText(output).then(() => {
      showNotification('DOM 结构已复制到剪贴板! 请粘贴给 Claude 分析~');
      console.log('[Claude Enhance] DOM structure copied to clipboard');
    }).catch(err => {
      console.error('[Claude Enhance] Failed to copy:', err);
      // 降级: 打印到控制台
      console.log('[Claude Enhance] DOM Structure:\n', output);
      showNotification('复制失败, 请查看控制台 (F12)');
    });
  }

  function analyzeElement(el, depth, maxDepth) {
    if (depth > maxDepth) return { truncated: true };

    const info = {
      tag: el.tagName,
      className: el.className || null,
      id: el.id || null,
      childCount: el.children.length
    };

    // 检查特殊属性
    const attrs = ['role', 'data-message', 'data-turn', 'data-type', 'data-testid'];
    attrs.forEach(attr => {
      if (el.hasAttribute(attr)) {
        info[attr] = el.getAttribute(attr);
      }
    });

    // 递归分析子元素 (只分析前几个)
    if (el.children.length > 0 && depth < maxDepth) {
      info.children = Array.from(el.children)
        .slice(0, 5)
        .map(child => analyzeElement(child, depth + 1, maxDepth));
      if (el.children.length > 5) {
        info.moreChildren = el.children.length - 5;
      }
    }

    return info;
  }

  function showNotification(message) {
    let notification = document.getElementById('claude-notification');
    if (!notification) {
      notification = document.createElement('div');
      notification.id = 'claude-notification';
      notification.style.cssText = `
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(30, 30, 30, 0.95); color: #4ade80;
        padding: 16px 24px; border-radius: 8px; font-size: 14px;
        z-index: 10001; border: 1px solid #4ade80;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      `;
      document.body.appendChild(notification);
    }
    notification.textContent = message;
    notification.style.display = 'block';
    notification.style.opacity = '1';
    setTimeout(() => {
      notification.style.opacity = '0';
      setTimeout(() => { notification.style.display = 'none'; }, 300);
    }, 2000);
  }

  // 初始化
  function init() {
    console.log('[Claude Enhance] Initializing...');
    injectStyles();
    injectHighlightJS();
    injectKaTeX();
    setupZoom();
    setupObserver();
    setupDOMInspector();
    highlightAllCode();
    renderLaTeX();
    renderMathPlaceholders();  // Phase 2
    renderBlockDisplayMath();
    repairKatexErrors();
    scanAndAddCopyButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
