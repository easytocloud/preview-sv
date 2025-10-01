import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const pExecFile = promisify(execFile);

type Cfg = {
  runner: string;
  command: string;
  runnerArgs: string[];
  args: string[];
  onSave: 'refresh' | 'off';
  onChange: boolean;
  argsBeforeFile: boolean;
  autoOnOpen: boolean;
  renderTimeoutMs: number;
  excludePattern: string;
};

let sharedPanel: vscode.WebviewPanel | undefined;
let currentUri: vscode.Uri | undefined;
let changeTimers = new Map<string, NodeJS.Timeout>();

export function activate(context: vscode.ExtensionContext) {
  const open = vscode.commands.registerCommand('sv2svgPreview.open', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showInformationMessage('No active SystemVerilog file to preview.');
      return;
    }
    await openPreview(target, vscode.ViewColumn.Active, context);
  });

  const openToSide = vscode.commands.registerCommand('sv2svgPreview.openToSide', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showInformationMessage('No active SystemVerilog file to preview.');
      return;
    }
    await openPreview(target, vscode.ViewColumn.Beside, context);
  });

  const refresh = vscode.commands.registerCommand('sv2svgPreview.refresh', async () => {
    if (!sharedPanel || !currentUri) {
      vscode.window.showInformationMessage('Preview .sv is not open.');
      return;
    }
    await renderToPanel(currentUri, sharedPanel, context);
  });

  const toggleAuto = vscode.commands.registerCommand('sv2svgPreview.toggleAuto', async () => {
    const cfg = vscode.workspace.getConfiguration('sv2svgPreview');
    const cur = cfg.get<boolean>('autoOnOpen', false);
    await cfg.update('autoOnOpen', !cur, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('setContext', 'sv2svgPreview.autoOn', !cur);
    vscode.window.setStatusBarMessage(`Preview .sv auto-open ${!cur ? 'enabled' : 'disabled'}`, 2000);
  });

  context.subscriptions.push(open, openToSide, refresh, toggleAuto);

  vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const cfg = getCfg();
    if (cfg.onSave !== 'refresh') return;
    if (sharedPanel && currentUri && doc.uri.toString() === currentUri.toString()) {
      await renderToPanel(doc.uri, sharedPanel, context);
    }
  });

  vscode.workspace.onDidChangeTextDocument((e) => {
    const cfg = getCfg();
    if (!cfg.onChange) return;
    if (!sharedPanel || !currentUri) return;
    if (e.document.uri.toString() !== currentUri.toString()) return;
    const key = e.document.uri.toString();
    if (changeTimers.has(key)) clearTimeout(changeTimers.get(key)!);
    changeTimers.set(key, setTimeout(async () => {
      await renderToPanel(e.document.uri, sharedPanel!, context, /*useTemp*/ true);
    }, 500));
  });

  // Auto open preview on active editor change if setting enabled
  vscode.window.onDidChangeActiveTextEditor((ed) => {
    if (!ed) return;
    maybeAutoOpen(ed.document.uri, context);
  });

  // On startup, attempt auto-open for the active editor
  if (vscode.window.activeTextEditor) {
    maybeAutoOpen(vscode.window.activeTextEditor.document.uri, context);
  }
}

export function deactivate() {
  sharedPanel?.dispose();
  sharedPanel = undefined;
  currentUri = undefined;
}

async function openPreview(uri: vscode.Uri, viewColumn: vscode.ViewColumn, ctx: vscode.ExtensionContext) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Workspace is not trusted. sv2svg will not be executed.');
    return;
  }
  if (isExcluded(uri)) {
    vscode.window.showInformationMessage('Preview is disabled for excluded files (testbenches).');
    return;
  }

  const previousEditor = vscode.window.activeTextEditor;
  currentUri = uri;

  if (sharedPanel) {
  } else {
    sharedPanel = vscode.window.createWebviewPanel(
      'sv2svgPreview',
      makeTitle(uri),
      viewColumn,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    sharedPanel.onDidDispose(() => {
      sharedPanel = undefined;
      currentUri = undefined;
    });
    try { sharedPanel.iconPath = getIcon(ctx); } catch {}
  }

  sharedPanel.reveal(viewColumn, true);
  sharedPanel.title = makeTitle(uri);
  await renderToPanel(uri, sharedPanel, ctx);

  if (previousEditor && previousEditor.viewColumn !== undefined) {
    await vscode.window.showTextDocument(previousEditor.document, {
      viewColumn: previousEditor.viewColumn,
      preserveFocus: false,
    });
  }
}

function getCfg(): Cfg {
  const cfg = vscode.workspace.getConfiguration('sv2svgPreview');
  return {
    runner: cfg.get('runner', 'uvx'),
    command: cfg.get('command', 'sv2svg'),
    runnerArgs: cfg.get('runnerArgs', [] as string[]),
    args: cfg.get('args', [] as string[]),
    onSave: cfg.get<'refresh' | 'off'>('onSave', 'refresh'),
    onChange: cfg.get('onChange', false),
    argsBeforeFile: cfg.get('argsBeforeFile', false),
    autoOnOpen: cfg.get('autoOnOpen', false),
    renderTimeoutMs: cfg.get('renderTimeoutMs', 15000),
    excludePattern: cfg.get('excludePattern', '.*_tb\\.sv$'),
  };
}

async function renderToPanel(uri: vscode.Uri, panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, useTemp = false) {
  panel.webview.html = loadingHtml();
  try {
    const svg = await runSv2Svg(uri, useTemp);
    panel.webview.html = wrapSvg(svg);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    panel.webview.html = errorHtml(msg);
  }
}

function isSvFile(uri: vscode.Uri): boolean {
  const ext = path.extname(uri.fsPath).toLowerCase();
  return ext === '.sv' || ext === '.svh';
}

function isExcluded(uri: vscode.Uri): boolean {
  const cfg = getCfg();
  try {
    const re = new RegExp(cfg.excludePattern);
    return re.test(path.basename(uri.fsPath));
  } catch {
    return false;
  }
}

async function maybeAutoOpen(uri: vscode.Uri, ctx: vscode.ExtensionContext) {
  const cfg = getCfg();
  if (!cfg.autoOnOpen) return;
  if (!isSvFile(uri)) return;
  if (isExcluded(uri)) return;
  await openPreview(uri, vscode.ViewColumn.Beside, ctx);
}

function makeTitle(uri: vscode.Uri): string {
  const name = path.parse(uri.fsPath).name;
  return `Preview ${name}`;
}

function getIcon(ctx: vscode.ExtensionContext): vscode.Uri | { light: vscode.Uri, dark: vscode.Uri } {
  const icon = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
  return icon;
}

async function runSv2Svg(uri: vscode.Uri, useTemp: boolean): Promise<string> {
  const cfg = getCfg();
  const cwd = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || path.dirname(uri.fsPath);
  const timeout = cfg.renderTimeoutMs;

  let targetPath = uri.fsPath;
  let tmpPath: string | undefined;

  if (useTemp) {
    // Write current unsaved contents to a temp file for preview
    const doc = await vscode.workspace.openTextDocument(uri);
    tmpPath = path.join(os.tmpdir(), `sv2svg-preview-${Date.now()}-${path.basename(uri.fsPath)}`);
    await fs.promises.writeFile(tmpPath, doc.getText(), 'utf8');
    targetPath = tmpPath;
  }

  // First attempt: stdout mode using configured args
  const args = buildArgs(cfg, targetPath, cfg.args);
  const fullArgs = [...cfg.runnerArgs, ...args];
  try {
    const { stdout } = await pExecFile(cfg.runner, fullArgs, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
    const svg = extractSvg(stdout.toString());
    if (!svg) throw new Error('No SVG found in stdout');
    return svg;
  } catch (e: any) {
    // If stdout mode likely failed (e.g., requires file extension), retry to a temp .svg
    const outTmp = path.join(os.tmpdir(), `sv2svg-out-${Date.now()}-${path.basename(uri.fsPath)}.svg`);
    try {
      const argsWithFile = rewriteOutputPath(fullArgs, outTmp);
      const { stdout, stderr } = await pExecFile(cfg.runner, argsWithFile, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
      // Prefer reading file if created, else try stdout as svg
      const exists = await fileExists(outTmp);
      if (exists) {
        const data = await fs.promises.readFile(outTmp, 'utf8');
        return data;
      }
      const svg2 = extractSvg(stdout?.toString() || '');
      if (svg2) return svg2;
      const msg = e?.message || 'Unknown error';
      const cmd = `${cfg.runner} ${shellEscape(argsWithFile)}`;
      throw new Error(`${stderr?.toString() || msg}\n\nCommand: ${cmd}`);
    } finally {
      fs.promises.unlink(outTmp).catch(() => {});
    }
  } finally {
    if (tmpPath) {
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
}

function buildArgs(cfg: Cfg, filePath: string, extra: string[]): string[] {
  const sequence: string[] = [];
  sequence.push(cfg.command);
  if (cfg.argsBeforeFile) sequence.push(...extra);
  sequence.push(filePath);
  if (!cfg.argsBeforeFile) sequence.push(...extra);
  return sequence;
}

function rewriteOutputPath(args: string[], newPath: string): string[] {
  // Replace '-o -' or '--output -' with the provided path.
  const res = [...args];
  for (let i = 0; i < res.length; i++) {
    const a = res[i];
    if ((a === '-o' || a === '--output') && i + 1 < res.length && res[i + 1] === '-') {
      res[i + 1] = newPath;
      return res;
    }
  }
  // If no explicit stdout marker, append output arg for common CLIs
  res.push('-o', newPath);
  return res;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p, fs.constants.F_OK); return true; } catch { return false; }
}

function extractSvg(s: string): string | null {
  const start = s.indexOf('<svg');
  if (start === -1) return null;
  // Try to find closing tag; if missing, return from start
  const endIdx = s.lastIndexOf('</svg>');
  const body = endIdx !== -1 ? s.slice(start, endIdx + 6) : s.slice(start);
  return body.trim();
}

function shellEscape(parts: string[]): string {
  return parts.map(p => /[\s"'`$]/.test(p) ? `'` + p.replace(/'/g, `'"'"'`) + `'` : p).join(' ');
}

function loadingHtml(): string {
  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8">
  <style>
    html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    .wrap { height: 100%; display: grid; place-items: center; font-family: var(--vscode-font-family); }
  </style>
  </head><body><div class="wrap">Rendering…</div></body></html>`;
}

function errorHtml(msg: string): string {
  const esc = msg.replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s] as string));
  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8">
  <style>
    html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    pre { white-space: pre-wrap; padding: 1rem; }
  </style>
  </head><body><pre>${esc}</pre></body></html>`;
}

function wrapSvg(svg: string): string {
  // Embed basic pan/zoom controls; we operate via viewBox manipulation when present, else scale transform.
  return `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); }
      #toolbar { position: fixed; top: 8px; right: 8px; z-index: 10; display: flex; gap: 6px; }
      button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: 500; }
      button:hover { background: var(--vscode-button-hoverBackground); }
      #container { width: 100%; height: 100%; overflow: hidden; cursor: grab; }
      #container.panning { cursor: grabbing; }
      svg { width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div id="toolbar">
      <button id="zoomIn" title="Zoom In">＋</button>
      <button id="zoomOut" title="Zoom Out">－</button>
      <button id="reset" title="Reset">Reset</button>
    </div>
    <div id="container">${svg}</div>
    <script>
      (function(){
        const container = document.getElementById('container');
        const svg = container.querySelector('svg');
        if (!svg) return;

        const hasViewBox = svg.hasAttribute('viewBox');
        const viewBoxAttr = svg.getAttribute('viewBox');

        const zoomIn = document.getElementById('zoomIn');
        const zoomOut = document.getElementById('zoomOut');
        const reset = document.getElementById('reset');

        zoomIn.addEventListener('click', ()=> {
          if (!hasViewBox) return;
          const parts = svg.getAttribute('viewBox').split(' ');
          if (parts.length === 4) {
            const vb = parts.map(Number);
            // Zoom in: reduce width/height by 20%
            const newW = vb[2] * 0.8;
            const newH = vb[3] * 0.8;
            const newX = vb[0] + (vb[2] - newW) / 2;
            const newY = vb[1] + (vb[3] - newH) / 2;
            svg.setAttribute('viewBox', [newX, newY, newW, newH].join(' '));
          }
        });

        zoomOut.addEventListener('click', ()=> {
          if (!hasViewBox) return;
          const parts = svg.getAttribute('viewBox').split(' ');
          if (parts.length === 4) {
            const vb = parts.map(Number);
            // Zoom out: increase width/height by 25%
            const newW = vb[2] * 1.25;
            const newH = vb[3] * 1.25;
            const newX = vb[0] - (newW - vb[2]) / 2;
            const newY = vb[1] - (newH - vb[3]) / 2;
            svg.setAttribute('viewBox', [newX, newY, newW, newH].join(' '));
          }
        });

        reset.addEventListener('click', ()=> {
          if (!hasViewBox) return;
          svg.setAttribute('viewBox', viewBoxAttr);
        });

        // Pan/drag functionality
        let panning = false;
        let startX = 0;
        let startY = 0;

        container.addEventListener('mousedown', (e)=> {
          if (e.button === 0 && hasViewBox) {
            panning = true;
            startX = e.clientX;
            startY = e.clientY;
            container.classList.add('panning');
            e.preventDefault();
          }
        });

        window.addEventListener('mousemove', (e)=> {
          if (!panning) return;

          const dx = e.clientX - startX;
          const dy = e.clientY - startY;

          const parts = svg.getAttribute('viewBox').split(' ');
          if (parts.length === 4) {
            const vb = parts.map(Number);
            const containerRect = container.getBoundingClientRect();
            // Convert screen pixel movement to viewBox units
            const vbDx = -(dx / containerRect.width) * vb[2];
            const vbDy = -(dy / containerRect.height) * vb[3];
            svg.setAttribute('viewBox', [(vb[0] + vbDx), (vb[1] + vbDy), vb[2], vb[3]].join(' '));
          }

          startX = e.clientX;
          startY = e.clientY;
        });

        window.addEventListener('mouseup', ()=> {
          panning = false;
          container.classList.remove('panning');
        });

        // Mouse wheel zoom
        container.addEventListener('wheel', (e)=> {
          if (!hasViewBox) return;
          e.preventDefault();
          const parts = svg.getAttribute('viewBox').split(' ');
          if (parts.length === 4) {
            const vb = parts.map(Number);
            const factor = e.deltaY < 0 ? 0.9 : 1.1;
            const newW = vb[2] * factor;
            const newH = vb[3] * factor;
            const newX = vb[0] + (vb[2] - newW) / 2;
            const newY = vb[1] + (vb[3] - newH) / 2;
            svg.setAttribute('viewBox', [newX, newY, newW, newH].join(' '));
          }
        }, { passive: false });
      })();
    </script>
  </body>
  </html>`;
}
