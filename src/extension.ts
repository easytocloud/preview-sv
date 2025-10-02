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

type Sv2SvgOptions = {
  inputOrder: 'alpha' | 'ports' | 'auto';
  gridX: number;
  gridY: number;
  noSymmetry: boolean;
  style: 'classic' | 'blueprint' | 'midnight' | 'mono' | 'vibrant' | 'dark';
  orientation: 'horizontal' | 'vertical';
  table: boolean;
  noCaption: boolean;
  fillGates: boolean;
  signalStyles: boolean;
  fanoutWires: boolean;
};

let sharedPanel: vscode.WebviewPanel | undefined;
let currentUri: vscode.Uri | undefined;
let changeTimers = new Map<string, NodeJS.Timeout>();
let currentSv2SvgOptions: Sv2SvgOptions | undefined;

function getDefaultSv2SvgOptions(): Sv2SvgOptions {
  return {
    inputOrder: 'alpha',
    gridX: 0,
    gridY: 0,
    noSymmetry: false,
    style: 'classic',
    orientation: 'horizontal',
    table: false,
    noCaption: false,
    fillGates: false,
    signalStyles: false,
    fanoutWires: false,
  };
}

function loadSv2SvgOptions(): Sv2SvgOptions {
  const cfg = vscode.workspace.getConfiguration('sv2svgPreview.renderOptions');
  return {
    inputOrder: cfg.get('inputOrder', 'alpha'),
    gridX: cfg.get('gridX', 0),
    gridY: cfg.get('gridY', 0),
    noSymmetry: cfg.get('noSymmetry', false),
    style: cfg.get('style', 'classic'),
    orientation: cfg.get('orientation', 'horizontal'),
    table: cfg.get('table', false),
    noCaption: cfg.get('noCaption', false),
    fillGates: cfg.get('fillGates', false),
    signalStyles: cfg.get('signalStyles', false),
    fanoutWires: cfg.get('fanoutWires', false),
  };
}

async function saveSv2SvgOptions(options: Sv2SvgOptions): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('sv2svgPreview.renderOptions');
  await cfg.update('inputOrder', options.inputOrder, vscode.ConfigurationTarget.Workspace);
  await cfg.update('gridX', options.gridX, vscode.ConfigurationTarget.Workspace);
  await cfg.update('gridY', options.gridY, vscode.ConfigurationTarget.Workspace);
  await cfg.update('noSymmetry', options.noSymmetry, vscode.ConfigurationTarget.Workspace);
  await cfg.update('style', options.style, vscode.ConfigurationTarget.Workspace);
  await cfg.update('orientation', options.orientation, vscode.ConfigurationTarget.Workspace);
  await cfg.update('table', options.table, vscode.ConfigurationTarget.Workspace);
  await cfg.update('noCaption', options.noCaption, vscode.ConfigurationTarget.Workspace);
  await cfg.update('fillGates', options.fillGates, vscode.ConfigurationTarget.Workspace);
  await cfg.update('signalStyles', options.signalStyles, vscode.ConfigurationTarget.Workspace);
  await cfg.update('fanoutWires', options.fanoutWires, vscode.ConfigurationTarget.Workspace);
}

export function activate(context: vscode.ExtensionContext) {
  // Load saved render options or use defaults
  currentSv2SvgOptions = loadSv2SvgOptions();

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

    // Handle messages from the webview
    sharedPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'updateSettings':
          const newSettings = message.settings as Sv2SvgOptions;
          currentSv2SvgOptions = newSettings;
          await saveSv2SvgOptions(newSettings);
          if (currentUri && sharedPanel) {
            await renderToPanel(currentUri, sharedPanel, ctx);
          }
          break;
        case 'resetSettings':
          const defaultSettings = getDefaultSv2SvgOptions();
          currentSv2SvgOptions = defaultSettings;
          await saveSv2SvgOptions(defaultSettings);
          if (currentUri && sharedPanel) {
            await renderToPanel(currentUri, sharedPanel, ctx);
          }
          break;
      }
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
  const options = currentSv2SvgOptions || getDefaultSv2SvgOptions();
  const args = buildArgs(cfg, targetPath, cfg.args, options);
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

function buildArgs(cfg: Cfg, filePath: string, extra: string[], options: Sv2SvgOptions): string[] {
  const sequence: string[] = [];
  sequence.push(cfg.command);

  // Build sv2svg options
  const sv2svgArgs: string[] = [];

  // Input order
  if (options.inputOrder !== 'alpha') {
    sv2svgArgs.push('--input-order', options.inputOrder);
  }

  // Grid settings
  if (options.gridX > 0) {
    sv2svgArgs.push('--grid-x', String(options.gridX));
  }
  if (options.gridY > 0) {
    sv2svgArgs.push('--grid-y', String(options.gridY));
  }

  // Boolean flags
  if (options.noSymmetry) sv2svgArgs.push('--no-symmetry');
  if (options.table) sv2svgArgs.push('--table');
  if (options.noCaption) sv2svgArgs.push('--no-caption');
  if (options.fillGates) sv2svgArgs.push('--fill-gates');
  if (options.signalStyles) sv2svgArgs.push('--signal-styles');
  if (options.fanoutWires) sv2svgArgs.push('--fanout-wires');

  // Style
  if (options.style !== 'classic') {
    sv2svgArgs.push('--style', options.style);
  }

  // Orientation
  if (options.orientation !== 'horizontal') {
    sv2svgArgs.push('--orientation', options.orientation);
  }

  // Combine all args
  if (cfg.argsBeforeFile) {
    sequence.push(...sv2svgArgs, ...extra);
  }
  sequence.push(filePath);
  if (!cfg.argsBeforeFile) {
    sequence.push(...sv2svgArgs, ...extra);
  }

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
  const options = currentSv2SvgOptions || getDefaultSv2SvgOptions();
  const optionsJson = JSON.stringify(options);
  return `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      html, body {
        height: 100%;
        margin: 0;
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }

      /* Ultra-minimal floating toolbar */
      #toolbar {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 10;
        display: flex;
        gap: 2px;
        background: rgba(127, 127, 127, 0.08);
        padding: 4px;
        border-radius: 20px;
        border: 1px solid rgba(127, 127, 127, 0.15);
        backdrop-filter: blur(10px);
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        opacity: 0.7;
      }

      #toolbar:hover {
        opacity: 1;
        background: rgba(127, 127, 127, 0.12);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        transform: scale(1.02);
      }

      button {
        background: transparent;
        color: var(--vscode-foreground);
        border: none;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 20px;
        font-weight: 300;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.8;
        position: relative;
      }

      button:hover {
        opacity: 1;
        background: rgba(127, 127, 127, 0.2);
        transform: scale(1.1);
      }

      button:active {
        transform: scale(0.95);
      }

      button::after {
        content: attr(title);
        position: absolute;
        bottom: -32px;
        left: 50%;
        transform: translateX(-50%) scale(0.9);
        background: var(--vscode-editorHoverWidget-background);
        color: var(--vscode-editorHoverWidget-foreground);
        border: 1px solid var(--vscode-editorHoverWidget-border);
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: all 0.2s ease;
        z-index: 1000;
      }

      button:hover::after {
        opacity: 1;
        transform: translateX(-50%) scale(1);
      }

      /* Settings panel */
      #settingsPanel {
        position: fixed;
        top: 0;
        right: -400px;
        width: 380px;
        height: 100%;
        background: var(--vscode-sideBar-background);
        border-left: 1px solid var(--vscode-widget-border);
        z-index: 20;
        transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        overflow-y: auto;
        box-shadow: -4px 0 12px rgba(0,0,0,0.3);
      }

      #settingsPanel.open {
        right: 0;
      }

      .panel-header {
        padding: 16px 20px;
        background: var(--vscode-titleBar-activeBackground);
        border-bottom: 1px solid var(--vscode-widget-border);
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .panel-header h2 {
        margin: 0 0 4px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--vscode-titleBar-activeForeground);
      }

      .panel-header p {
        margin: 0;
        font-size: 11px;
        opacity: 0.7;
        color: var(--vscode-titleBar-activeForeground);
      }

      .panel-content {
        padding: 16px 20px;
      }

      .setting-group {
        margin-bottom: 20px;
      }

      .setting-group h3 {
        margin: 0 0 10px 0;
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-foreground);
        text-transform: uppercase;
        letter-spacing: 0.8px;
        opacity: 0.6;
      }

      .setting-item {
        margin-bottom: 12px;
      }

      label {
        display: block;
        margin-bottom: 5px;
        font-size: 12px;
        color: var(--vscode-foreground);
        font-weight: 500;
      }

      .label-desc {
        display: block;
        font-size: 10px;
        opacity: 0.6;
        font-weight: 400;
        margin-top: 1px;
      }

      select, input[type="number"] {
        width: 100%;
        padding: 7px 10px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        border-radius: 4px;
        font-family: inherit;
        font-size: 12px;
        transition: border-color 0.2s;
      }

      select:focus, input[type="number"]:focus {
        outline: none;
        border-color: var(--vscode-focusBorder);
      }

      .checkbox-group {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 0;
      }

      input[type="checkbox"] {
        width: 16px;
        height: 16px;
        cursor: pointer;
        accent-color: var(--vscode-button-background);
      }

      .checkbox-group label {
        margin: 0;
        cursor: pointer;
        flex: 1;
        font-size: 12px;
      }

      .panel-actions {
        padding: 16px 20px;
        background: var(--vscode-editor-background);
        border-top: 1px solid var(--vscode-widget-border);
        display: flex;
        gap: 10px;
        position: sticky;
        bottom: 0;
      }

      .panel-actions button {
        flex: 1;
        width: auto;
        height: auto;
        border-radius: 6px;
        padding: 10px 20px;
        font-size: 12px;
        font-weight: 500;
        opacity: 1;
        letter-spacing: 0.3px;
      }

      .panel-actions button::after {
        display: none;
      }

      #resetBtn {
        background: transparent;
        color: var(--vscode-foreground);
        border: 1px solid rgba(127, 127, 127, 0.3);
      }

      #resetBtn:hover {
        background: rgba(127, 127, 127, 0.1);
        border-color: rgba(127, 127, 127, 0.5);
        transform: none;
      }

      #applyBtn {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: 1px solid transparent;
      }

      #applyBtn:hover {
        background: var(--vscode-button-hoverBackground);
        transform: none;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      }

      #container {
        width: 100%;
        height: 100%;
        overflow: hidden;
        cursor: grab;
      }

      #container.panning {
        cursor: grabbing;
      }

      svg {
        width: 100%;
        height: 100%;
      }

      /* Overlay when panel is open */
      #overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.4);
        z-index: 15;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }

      #overlay.visible {
        opacity: 1;
        pointer-events: all;
      }

      .grid-inputs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
    </style>
  </head>
  <body>
    <div id="overlay"></div>

    <div id="toolbar">
      <button id="zoomIn" title="Zoom In (+)">+</button>
      <button id="zoomOut" title="Zoom Out (−)">−</button>
      <button id="reset" title="Reset (0)">⌂</button>
      <button id="menuBtn" title="Settings (S)">⚙</button>
    </div>

    <div id="settingsPanel">
      <div class="panel-header">
        <h2>sv2svg Settings</h2>
        <p>Configure schematic rendering options</p>
      </div>

      <div class="panel-content">
        <div class="setting-group">
          <h3>Appearance</h3>

          <div class="setting-item">
            <label>
              Style Theme
              <span class="label-desc">Color and line weight preset</span>
            </label>
            <select id="style">
              <option value="classic">Classic</option>
              <option value="blueprint">Blueprint</option>
              <option value="midnight">Midnight</option>
              <option value="mono">Monochrome</option>
              <option value="vibrant">Vibrant</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <div class="setting-item">
            <label>
              Orientation
              <span class="label-desc">Diagram layout direction</span>
            </label>
            <select id="orientation">
              <option value="horizontal">Horizontal (Left to Right)</option>
              <option value="vertical">Vertical (Top to Bottom)</option>
            </select>
          </div>
        </div>

        <div class="setting-group">
          <h3>Layout</h3>

          <div class="setting-item">
            <label>
              Input Order
              <span class="label-desc">Order primary inputs top-to-bottom</span>
            </label>
            <select id="inputOrder">
              <option value="alpha">Alphabetical</option>
              <option value="ports">Port Order</option>
              <option value="auto">Auto (ports if available)</option>
            </select>
          </div>

          <div class="setting-item">
            <label>Grid Snapping</label>
            <div class="grid-inputs">
              <div>
                <label>
                  Grid X
                  <span class="label-desc">0 = disabled</span>
                </label>
                <input type="number" id="gridX" min="0" max="100" step="1">
              </div>
              <div>
                <label>
                  Grid Y
                  <span class="label-desc">0 = disabled</span>
                </label>
                <input type="number" id="gridY" min="0" max="100" step="1">
              </div>
            </div>
          </div>
        </div>

        <div class="setting-group">
          <h3>Enhancements</h3>

          <div class="checkbox-group">
            <input type="checkbox" id="fillGates">
            <label for="fillGates">
              Fill Gates
              <span class="label-desc">Subtle fill colors for logic gates</span>
            </label>
          </div>

          <div class="checkbox-group">
            <input type="checkbox" id="signalStyles">
            <label for="signalStyles">
              Signal Styles
              <span class="label-desc">Different line styles for signal types</span>
            </label>
          </div>

          <div class="checkbox-group">
            <input type="checkbox" id="fanoutWires">
            <label for="fanoutWires">
              Fanout Wires
              <span class="label-desc">Thicker wires for higher fan-out</span>
            </label>
          </div>

          <div class="checkbox-group">
            <input type="checkbox" id="table">
            <label for="table">
              Truth Table
              <span class="label-desc">Include truth table in diagram</span>
            </label>
          </div>
        </div>

        <div class="setting-group">
          <h3>Advanced</h3>

          <div class="checkbox-group">
            <input type="checkbox" id="noSymmetry">
            <label for="noSymmetry">
              Disable Symmetry
              <span class="label-desc">Turn off symmetric sibling placement</span>
            </label>
          </div>

          <div class="checkbox-group">
            <input type="checkbox" id="noCaption">
            <label for="noCaption">
              No Caption
              <span class="label-desc">Hide module name caption</span>
            </label>
          </div>
        </div>
      </div>

      <div class="panel-actions">
        <button id="resetBtn">Reset to Defaults</button>
        <button id="applyBtn">Apply</button>
      </div>
    </div>

    <div id="container">${svg}</div>

    <script>
      const vscode = acquireVsCodeApi();

      (function(){
        const container = document.getElementById('container');
        const svg = container.querySelector('svg');
        if (!svg) return;

        const hasViewBox = svg.hasAttribute('viewBox');
        const viewBoxAttr = svg.getAttribute('viewBox');

        // Zoom controls (unchanged logic)
        const zoomIn = document.getElementById('zoomIn');
        const zoomOut = document.getElementById('zoomOut');
        const reset = document.getElementById('reset');

        zoomIn.addEventListener('click', ()=> {
          if (!hasViewBox) return;
          const parts = svg.getAttribute('viewBox').split(' ');
          if (parts.length === 4) {
            const vb = parts.map(Number);
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

        // Pan/drag functionality (unchanged)
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

        // Settings panel
        const panel = document.getElementById('settingsPanel');
        const overlay = document.getElementById('overlay');
        const menuBtn = document.getElementById('menuBtn');
        const applyBtn = document.getElementById('applyBtn');
        const resetBtn = document.getElementById('resetBtn');

        // Load current settings
        const currentSettings = ${optionsJson};

        function loadSettings(settings) {
          document.getElementById('inputOrder').value = settings.inputOrder;
          document.getElementById('gridX').value = settings.gridX;
          document.getElementById('gridY').value = settings.gridY;
          document.getElementById('noSymmetry').checked = settings.noSymmetry;
          document.getElementById('style').value = settings.style;
          document.getElementById('orientation').value = settings.orientation;
          document.getElementById('table').checked = settings.table;
          document.getElementById('noCaption').checked = settings.noCaption;
          document.getElementById('fillGates').checked = settings.fillGates;
          document.getElementById('signalStyles').checked = settings.signalStyles;
          document.getElementById('fanoutWires').checked = settings.fanoutWires;
        }

        function getSettings() {
          return {
            inputOrder: document.getElementById('inputOrder').value,
            gridX: parseInt(document.getElementById('gridX').value) || 0,
            gridY: parseInt(document.getElementById('gridY').value) || 0,
            noSymmetry: document.getElementById('noSymmetry').checked,
            style: document.getElementById('style').value,
            orientation: document.getElementById('orientation').value,
            table: document.getElementById('table').checked,
            noCaption: document.getElementById('noCaption').checked,
            fillGates: document.getElementById('fillGates').checked,
            signalStyles: document.getElementById('signalStyles').checked,
            fanoutWires: document.getElementById('fanoutWires').checked,
          };
        }

        loadSettings(currentSettings);

        menuBtn.addEventListener('click', () => {
          panel.classList.add('open');
          overlay.classList.add('visible');
        });

        overlay.addEventListener('click', () => {
          panel.classList.remove('open');
          overlay.classList.remove('visible');
        });

        applyBtn.addEventListener('click', () => {
          const settings = getSettings();
          vscode.postMessage({ type: 'updateSettings', settings });
          panel.classList.remove('open');
          overlay.classList.remove('visible');
        });

        resetBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'resetSettings' });
          panel.classList.remove('open');
          overlay.classList.remove('visible');
        });

        // Keyboard shortcuts
        window.addEventListener('keydown', (e) => {
          // Ignore if typing in input fields
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
            // Allow Escape to close panel even when focused on input
            if (e.key === 'Escape') {
              panel.classList.remove('open');
              overlay.classList.remove('visible');
            }
            return;
          }

          switch(e.key) {
            case '+':
            case '=':
              e.preventDefault();
              zoomIn.click();
              break;
            case '-':
            case '_':
              e.preventDefault();
              zoomOut.click();
              break;
            case '0':
              e.preventDefault();
              reset.click();
              break;
            case 's':
            case 'S':
              e.preventDefault();
              if (panel.classList.contains('open')) {
                panel.classList.remove('open');
                overlay.classList.remove('visible');
              } else {
                panel.classList.add('open');
                overlay.classList.add('visible');
              }
              break;
            case 'Escape':
              panel.classList.remove('open');
              overlay.classList.remove('visible');
              break;
          }
        });
      })();
    </script>
  </body>
  </html>`;
}
