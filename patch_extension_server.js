#!/usr/bin/env node
/**
 * Claude Code extension patch (VSCode Server / Remote variant)
 *
 * Adapted from patch_extension.js for:
 *   - ~/.vscode-server/extensions/ (instead of ~/.vscode/extensions/)
 *   - Claude Code 2.1.116 webview variable names:
 *         asWebviewUri binding : V   (was z in 2.1.31, K in 2.1.112)
 *         Uri.joinPath namespace : S0 (was F0 in 2.1.31)
 *
 * Idempotent: re-running after an extension update re-applies cleanly.
 */

const fs = require('fs');
const path = require('path');

// --- locate extension -------------------------------------------------
function findExtensionDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    path.join(home, '.vscode-server/extensions'),
    path.join(home, '.vscode/extensions'),
  ];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('anthropic.claude-code-'));
    if (dirs.length === 0) continue;
    const latest = dirs.sort().pop();
    return { base, dir: path.join(base, latest), name: latest };
  }
  console.error('[Patch] Claude Code extension not found under .vscode-server or .vscode');
  process.exit(1);
}

const { dir: extDir, name: extName } = findExtensionDir();
const extensionJs = path.join(extDir, 'extension.js');
const enhanceJs = path.join(__dirname, 'webview', 'enhance.js');
const targetEnhance = path.join(extDir, 'webview', 'enhance.js');

console.log('[Patch] Extension :', extName);
console.log('[Patch] Location  :', extDir);

// --- 1. copy enhance.js ----------------------------------------------
fs.copyFileSync(enhanceJs, targetEnhance);
console.log('[Patch] Copied enhance.js ->', targetEnhance);

// --- 2. edit extension.js --------------------------------------------
let content = fs.readFileSync(extensionJs, 'utf8');
let modified = false;

// 2a. style-src : add cdnjs
if (!/style-src[^`]*cdnjs/.test(content)) {
  const m = content.match(/(\w)=`style-src \$\{(\w)\.cspSource\} 'unsafe-inline'`/);
  if (m) {
    content = content.replace(m[0],
      `${m[1]}=\`style-src \${${m[2]}.cspSource} 'unsafe-inline' https://cdnjs.cloudflare.com\``);
    modified = true;
    console.log('[Patch] style-src CSP  : updated');
  } else {
    console.log('[Patch] style-src CSP  : pattern NOT found (skipped)');
  }
} else {
  console.log('[Patch] style-src CSP  : already patched');
}

// 2b. script-src : add cdnjs
if (!/script-src 'nonce-\$\{[^}]+\}' https:\/\/cdnjs/.test(content)) {
  const before = content;
  content = content.replace(
    /script-src 'nonce-\$\{(\w)\}'/g,
    "script-src 'nonce-${$1}' https://cdnjs.cloudflare.com");
  if (content !== before) {
    modified = true;
    console.log('[Patch] script-src CSP : updated');
  } else {
    console.log('[Patch] script-src CSP : pattern NOT found (skipped)');
  }
} else {
  console.log('[Patch] script-src CSP : already patched');
}

// 2c. font-src : add cdnjs + data:
if (!/font-src[^`]*cdnjs/.test(content)) {
  const m = content.match(/(\w)=`font-src \$\{(\w)\.cspSource\}`/);
  if (m) {
    content = content.replace(m[0],
      `${m[1]}=\`font-src \${${m[2]}.cspSource} https://cdnjs.cloudflare.com data:\``);
    modified = true;
    console.log('[Patch] font-src CSP   : updated');
  } else {
    console.log('[Patch] font-src CSP   : pattern NOT found (skipped)');
  }
} else {
  console.log('[Patch] font-src CSP   : already patched');
}

// 2d. inject <script src="enhance.js"> next to the main module script
//     Dynamically discover which variable binds asWebviewUri and which
//     namespace exposes Uri.joinPath, so we don't hard-code per-version
//     names (z/F0 in 2.1.31, V/S0 in 2.1.116, etc.).
if (!content.includes('enhance.js')) {
  const scriptMatch = content.match(
    /nonce="\$\{(\w+)\}" src="\$\{(\w+)\}" type="module"><\/script>/);
  if (!scriptMatch) {
    console.log('[Patch] script-tag     : pattern NOT found (skipped)');
  } else {
    const [full, nonceVar, srcVar] = scriptMatch;

    const webviewBindings = [...content.matchAll(/\b(\w+)\.asWebviewUri\b/g)]
      .map(m => m[1]).filter(n => n !== 'webview');
    const uriNamespaces   = [...content.matchAll(/\b(\w+)\.Uri\.joinPath\b/g)]
      .map(m => m[1]);

    const webviewVar = webviewBindings[0];
    const uriVar     = uriNamespaces[0];

    if (!webviewVar || !uriVar) {
      console.log('[Patch] script-tag     : could not resolve webview/Uri vars');
      console.log('          asWebviewUri bindings :', webviewBindings);
      console.log('          Uri.joinPath namespaces:', uriNamespaces);
    } else {
      const injected =
        `nonce="\${${nonceVar}}" src="\${${srcVar}}" type="module"></script>` +
        `<script nonce="\${${nonceVar}}" src="\${${webviewVar}.asWebviewUri(` +
        `${uriVar}.Uri.joinPath(this.extensionUri,"webview","enhance.js"))}"></script>`;
      content = content.replace(full, injected);
      modified = true;
      console.log(`[Patch] script-tag     : injected (webview=${webviewVar}, uri=${uriVar})`);
    }
  }
} else {
  console.log('[Patch] script-tag     : already injected');
}

// 2e. diff view side-panel tweak (best-effort, 2.1.31 era)
const beforeDiff = content;
content = content.replace(/let v=\{preview:!1\}/g,
                          'let v={preview:!1,viewColumn:tr.ViewColumn.Beside}');
content = content.replace(/let N=\{preview:!1,preserveFocus:!0\}/g,
                          'let N={preview:!1,preserveFocus:!0,viewColumn:Gt.ViewColumn.Beside}');
if (content !== beforeDiff) {
  modified = true;
  console.log('[Patch] diff viewColumn: updated');
} else {
  console.log('[Patch] diff viewColumn: pattern not found (skipped, not critical)');
}

// --- 3. persist --------------------------------------------------------
if (modified) {
  fs.writeFileSync(extensionJs, content, 'utf8');
  console.log('\n[Patch] Done. Reload the VSCode window:');
  console.log('        Ctrl+Shift+P  ->  Developer: Reload Window');
} else {
  console.log('\n[Patch] Nothing to change.');
}
