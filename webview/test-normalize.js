#!/usr/bin/env node
/**
 * Offline unit tests for the normalization pipeline.
 * Run: node webview/test-normalize.js
 *
 * Keeps a self-contained copy of the pure functions so we can iterate on
 * regex rules without touching the extension or reloading the webview.
 * After all tests pass, paste the functions into enhance.js verbatim.
 */

'use strict';

// ======================================================================
// Pure normalization functions (copy-paste into enhance.js module scope)
// ======================================================================

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

const MATH_CMD_ALT = MATH_CMD_LIST.join('|');
const BARE_CMD_RE = new RegExp(
  '(?<![\\\\a-zA-Z])(' + MATH_CMD_ALT + ')(?![a-zA-Z])',
  'g'
);
// Subscript-label commands: typically follow `|` as eval-bar subscripts.
// 不在 LEAD_PIPE_RE 里处理, 留给 restoreMissingSubscript 规则 C 处理下标 `|_\text{...}`.
const LABEL_CMDS = ['text','mathrm','mathbf','mathit','mathsf','mathtt'];
const NON_LABEL_CMDS = MATH_CMD_LIST.filter(c => !LABEL_CMDS.includes(c));
// Leading-pipe: | 前非字母数字 + 非 label 命令  ->  \  (假竖线换成反斜杠)
const LEAD_PIPE_RE = new RegExp(
  '(?<![A-Za-z0-9])\\|(' + NON_LABEL_CMDS.join('|') + ')(?![a-zA-Z])',
  'g'
);

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
  // 注意: 当替换是多字符 \cmd 且后面紧跟字母时, 必须插一个空格,
  // 否则 \DeltaE (KaTeX 视为未知命令 \DeltaE) 而非 \Delta E.
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

function restoreMissingBackslashes(tex) {
  // 1. 错位为 | 的 \cmd: `|cmd` 前面不是字母/数字 → `\cmd`  (删掉假竖线)
  tex = tex.replace(LEAD_PIPE_RE, '\\$1');
  // 2. 裸命令: `cmd` 前面不是 `\` 或字母 → `\cmd`
  tex = tex.replace(BARE_CMD_RE, '\\$1');
  return tex;
}

function restoreMissingSubscript(tex) {
  // A. 定界符 | 后直接接 { → _{
  //    \Big|{X} → \Big|_{X}
  tex = tex.replace(/(\\(?:[Bb]ig{1,2}|left|right)\s*\|)\{/g, '$1_{');

  // B. 大运算符 \int/\sum/... 后直接接 \text/\mathrm → 加 _
  //    \int\text{top} → \int_\text{top}
  tex = tex.replace(
    /(\\(?:int|oint|iint|iiint|sum|prod|coprod|bigcup|bigcap|bigoplus|bigotimes))\s*(\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt))\b/g,
    '$1_$2'
  );

  // C. 变量/闭括号后 |\text/\mathrm → |_\text (eval bar 下标)
  //    \mathbf{u}|\text{prescribed} → \mathbf{u}|_\text{prescribed}
  tex = tex.replace(
    /([A-Za-z}\)\]])\|\s*(\\(?:text|mathrm|mathbf|mathit))\b/g,
    '$1|_$2'
  );
  return tex;
}

function restoreMathSpacing(tex) {
  // --- 逗号 \, ---
  // `,` 紧贴 \cmd → \,
  tex = tex.replace(/,(?=\\[a-zA-Z])/g, '\\,');
  // `}`/`)`/`]` 后的 `,` + 字母/命令 → \,
  tex = tex.replace(/([})\]])(,)(?=\s*[A-Za-z\\])/g, '$1\\,');

  // --- 分号 \; ---
  // ;\cmd → \;
  tex = tex.replace(/;(?=\\[a-zA-Z])/g, '\\;');
  // ; 直接在 = 前/后 → \;
  tex = tex.replace(/;(?=\s*=)/g, '\\;');
  tex = tex.replace(/(?<==\s*);/g, '\\;');
  // `}`/`)`/`]` 后的 `;` + 字母/命令 → \;
  tex = tex.replace(/([})\]])(;)(?=\s*[A-Za-z\\])/g, '$1\\;');

  // --- 冒号 \: ---
  // :\cmd → \:
  tex = tex.replace(/:(?=\\[a-zA-Z])/g, '\\:');

  // --- 叹号 \! ---
  // 注意: 阶乘 n!, (n-1)! 要保留. 只在无歧义的负薄空格场景恢复.
  // (A) Frobenius 双内积 `!:!`:  }!:! 模式, `!` 前非字母/数字, 紧跟 `:`
  tex = tex.replace(/(?<![a-zA-Z0-9])!(?=:)/g, '\\!');
  // (B) :! 后接非字母/数字 (即 Frobenius 第二个 `!`)
  tex = tex.replace(/(?<=:)!(?![a-zA-Z0-9])/g, '\\!');
  // (C) !\cmd → \!\cmd, 但已经是 \! 的不再加 (负向 lookbehind 避免重复)
  tex = tex.replace(/(?<!\\)!(?=\\[a-zA-Z])/g, '\\!');
  // (不加 `}!/)!/]!` 规则 — 会误伤 (n-1)! 阶乘)
  return tex;
}

function normalizeMathSource(tex) {
  tex = normalizeUnicode(tex);
  tex = restoreMissingBackslashes(tex);
  tex = restoreMissingSubscript(tex);
  tex = restoreMathSpacing(tex);
  return tex;
}

// ======================================================================
// Golden test cases
// ======================================================================

const cases = [
  // ---------- 正例: 用户实际遇到的 bug ----------
  {
    name: '逗号+命令 恢复 \\,',
    in:  'M_{GB},P^2(1+\\nu),\\Delta E',
    out: 'M_{GB}\\,P^2(1+\\nu)\\,\\Delta E',
  },
  {
    name: '多行公式 完整恢复 (下标+反斜杠+\\,+\\neq)',
    in:  '\\frac{dW_\\text{ext}}{d\\eta}\\Big|{u_0} = |int\\text{top}\\frac{d\\mathbf{t}}{d\\eta}\\cdot\\mathbf{u}|text{prescribed},dA |neq 0.',
    out: '\\frac{dW_\\text{ext}}{d\\eta}\\Big|_{u_0} = \\int_\\text{top}\\frac{d\\mathbf{t}}{d\\eta}\\cdot\\mathbf{u}|_\\text{prescribed}\\,dA \\neq 0.',
  },
  {
    name: '{|cmd (|cmd }|cmd 恢复 \\cmd (但保留 }|\\text 的 eval-bar)',
    in:  '|bm{|varepsilon}|sim P(1-|nu^2)/E|text{eff}',
    // |bm 行首 → \bm
    // {|varepsilon} → {\varepsilon}
    // }|sim → }\sim (sim 不是 label, 把 | 当假反斜杠处理)
    // (1-|nu^2) → (1-\nu^2)
    // E|text → E|_\text (text 是 label, 保留 | 并走下标规则)
    out: '\\bm{\\varepsilon}\\sim P(1-\\nu^2)/E|_\\text{eff}',
  },
  {
    name: 'Gibbs 方程 \\;=\\; \\!:\\! \\,\\bm 全套恢复',
    in:  '\\frac{\\delta F_\\text{el}}{\\delta \\eta}\\Big|_\\text{eq};=;\\tfrac{1}{2},\\bm{\\varepsilon}_\\text{eq}!:!\\frac{\\partial \\mathbf{C}}{\\partial \\eta}!:!\\bm{\\varepsilon}_\\text{eq};=;\\frac{\\delta G}{\\delta \\eta}\\Big|_\\text{eq}',
    out: '\\frac{\\delta F_\\text{el}}{\\delta \\eta}\\Big|_\\text{eq}\\;=\\;\\tfrac{1}{2}\\,\\bm{\\varepsilon}_\\text{eq}\\!:\\!\\frac{\\partial \\mathbf{C}}{\\partial \\eta}\\!:\\!\\bm{\\varepsilon}_\\text{eq}\\;=\\;\\frac{\\delta G}{\\delta \\eta}\\Big|_\\text{eq}',
  },
  {
    name: 'Unicode 希腊字母归一化',
    in:  'v_n(θ) = \\frac{M P^2 (1+ν) ΔE}{Ē^2}',
    out: 'v_n(\\theta) = \\frac{M P^2 (1+\\nu) \\Delta E}{Ē^2}',  // Ē 不在表里，保留
  },
  {
    name: '裸函数名 cos → \\cos',
    in:  'cos^2\\theta - (1-\\nu)',
    out: '\\cos^2\\theta - (1-\\nu)',
  },

  // ---------- 反例: 不能误改 ----------
  {
    name: '函数参数逗号 (lowercase) 保留',
    in:  'f(x, y)',
    out: 'f(x, y)',
  },
  {
    name: '函数参数逗号 + \\delta (有空格) 保留',
    in:  'f(x, \\delta)',
    out: 'f(x, \\delta)',
  },
  {
    name: '阶乘 n! 保留',
    in:  'n! + (n-1)! = ?',
    out: 'n! + (n-1)! = ?',
  },
  {
    name: '集合逗号 \\{a, b, c\\} 保留',
    in:  '\\{a, b, c\\}',
    out: '\\{a, b, c\\}',
  },
  {
    name: '已正确的公式不变',
    in:  '\\int_0^1 f(x)\\,dx = \\frac{1}{2}',
    out: '\\int_0^1 f(x)\\,dx = \\frac{1}{2}',
  },
  {
    name: '正常 \\sin\\cos 前面已有 \\ 不重复',
    in:  '\\sin x + \\cos y',
    out: '\\sin x + \\cos y',
  },
];

// ======================================================================
// Runner
// ======================================================================

let pass = 0, fail = 0;
for (const c of cases) {
  const got = normalizeMathSource(c.in);
  if (got === c.out) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${c.name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${c.name}`);
    console.log(`    in:       ${JSON.stringify(c.in)}`);
    console.log(`    expected: ${JSON.stringify(c.out)}`);
    console.log(`    got:      ${JSON.stringify(got)}`);
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
