# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VS Code extension that renders SystemVerilog (.sv) files as SVG schematics using the external `sv2svg` tool (invoked via `uvx`). The extension provides a live preview panel with zoom/pan controls.

## Development Commands

### Build & Compile
```bash
npm install          # Install dependencies
npm run compile      # Compile TypeScript to out/
npm run watch        # Watch mode for development
```

### Testing & Running
```bash
code --extensionDevelopmentPath=.    # Launch extension in development mode
```

### Publishing (via Makefile)
```bash
make package              # Create .vsix package
make publish-patch        # Bump patch version and publish
make publish-minor        # Bump minor version and publish
make publish-major        # Bump major version and publish
make publish-ovsx         # Publish to Open VSX (requires OVSX_PAT env var)
```

## Architecture

### Single-File Extension Structure
The entire extension logic is in `src/extension.ts` (~440 lines). This is intentional for simplicity.

### Core Components

**1. Shared Preview Panel Pattern**
- Single `WebviewPanel` instance reused across file switches (`sharedPanel`)
- Tracks current file via `currentUri`
- Panel lifecycle: created on first preview, disposed when closed
- Uses `retainContextWhenHidden: true` to preserve state

**2. Command Registration (4 commands)**
- `sv2svgPreview.open` - Open preview in active column
- `sv2svgPreview.openToSide` - Open preview beside editor
- `sv2svgPreview.refresh` - Force re-render
- `sv2svgPreview.toggleAuto` - Toggle auto-preview on file switch

**3. Preview Rendering Flow**
```
renderToPanel() → runSv2Svg() → execute sv2svg CLI → extract SVG → wrapSvg()
```

**4. CLI Execution Strategy (Dual-Mode Fallback)**
- **Primary**: Attempt stdout mode using configured args (default: `-o -`)
- **Fallback**: If stdout fails, retry with temp file output
- Handles both saved files and unsaved buffers (via temp file)
- Timeout: 15s default (configurable)

**5. Configuration System**
All settings under `sv2svgPreview.*`:
- `runner` - Command to invoke (default: `uvx`)
- `command` - Tool name (default: `sv2svg`)
- `runnerArgs` / `args` - CLI arguments
- `argsBeforeFile` - Argument ordering flag
- `excludePattern` - Regex to skip files (default: `.*_tb\.sv$` for testbenches)
- `autoOnOpen` - Auto-preview on file activation
- `onChange` - Live preview while typing (debounced, uses temp file)
- `onSave` - Auto-refresh on save

**Render Options** (under `sv2svgPreview.renderOptions.*`):
- `inputOrder` - Input ordering: alpha, ports, auto (default: alpha)
- `gridX` / `gridY` - Grid snapping coordinates (0 = disabled)
- `noSymmetry` - Disable symmetric sibling placement
- `style` - Visual theme: classic, blueprint, midnight, mono, vibrant, dark
- `orientation` - Layout direction: horizontal, vertical
- `table` - Include truth table in diagram
- `noCaption` - Hide module name caption
- `fillGates` - Enable subtle fill colors for logic gates
- `signalStyles` - Different line styles for signal types
- `fanoutWires` - Thicker wires for higher fan-out signals

**Note**: Render options can be configured via in-preview settings panel (recommended) or VS Code settings UI.

### Webview Implementation

**Interactive SVG Viewer** (`wrapSvg()` function)
- **Zoom controls**: ±20% via viewBox manipulation, wheel zoom support
- **Pan/drag**: Mouse drag to pan across schematic
- **Settings panel**: Modern slide-out menu for sv2svg options
- **Ultra-minimal toolbar**: Compact pill-shaped floating control (top-right)
  - Icon-only design: + − ⌂ ⚙
  - Circular buttons (32px) with consistent styling
  - Glass morphism effect with backdrop blur
  - Subtle by default (70% opacity), full visibility on hover
  - Elegant scale and shadow animations
  - Custom tooltips showing keyboard shortcuts
- **Keyboard shortcuts**:
  - `+` / `=` - Zoom in
  - `-` - Zoom out
  - `0` - Reset view
  - `S` - Toggle settings panel
  - `Escape` - Close settings panel
- **Theme integration**: Uses VS Code CSS variables for consistent styling
- **Smooth animations**: Cubic-bezier easing for all transitions
- **Overlay**: Darkened backdrop when settings panel open

**Settings Panel Features**
- Organized into logical groups: Appearance, Layout, Enhancements, Advanced
- Compact, refined typography (11-12px) for dense but readable layout
- Form controls: Dropdowns for enums, number inputs for grids, checkboxes for toggles
- Elegant action buttons:
  - **Reset**: Outline style with subtle border
  - **Apply**: Solid style with shadow on hover
- Real-time preview: Apply button triggers re-render with new settings
- Reset to defaults: One-click restore to default sv2svg options
- Descriptive labels: Each option includes helpful description text

**Webview-Extension Communication**
- Uses `vscode.postMessage()` API for bidirectional communication
- Message types: `updateSettings`, `resetSettings`
- Settings serialized as JSON and injected into webview HTML
- Auto-saves to workspace configuration on Apply/Reset

### Event Handlers
- `onDidSaveTextDocument` - Auto-refresh when current file saved
- `onDidChangeTextDocument` - Debounced live preview (500ms delay)
- `onDidChangeActiveTextEditor` - Auto-open preview if enabled

## Key Design Decisions

1. **No Bundled Dependencies**: Extension requires external Python 3.9+, `uv`, and `sv2svg` (downloaded via `uvx`)
2. **Workspace Trust Required**: Won't execute external commands in untrusted workspaces
3. **File Extension Detection**: Supports `.sv` and `.svh` files
4. **Exclude Pattern**: Prevents testbench files from auto-preview (configurable regex)
5. **Error Display**: Shows stderr/error messages directly in webview for debugging
6. **In-Preview Settings**: Modern slide-out settings panel for sv2svg render options (no need to navigate to VS Code settings)
7. **Settings Persistence**: Render options saved to workspace configuration for consistency across sessions

## TypeScript Configuration

- **Target**: ES2020, CommonJS modules
- **Strict Mode**: Enabled
- **Output**: Compiled to `out/` directory
- **Source Maps**: Generated for debugging
- **Types**: `node`, `vscode` only

## Extension Activation

- Activates on command invocation
- Also activates on `onStartupFinished` to enable auto-preview on workspace open
- Checks for active editor and applies auto-open logic if configured

## Common Patterns

### Adding a New Command
1. Register command in `activate()` via `vscode.commands.registerCommand`
2. Add command to `contributes.commands` in package.json
3. Optionally add to `contributes.menus` for context menu/title bar
4. Add to subscription list: `context.subscriptions.push(yourCommand)`

### Modifying CLI Execution
- Update `buildArgs()` for argument construction logic (includes sv2svg render options)
- Modify `runSv2Svg()` for execution flow
- Use `rewriteOutputPath()` for output redirection logic
- **Important**: The `-o -` argument is hardwired for stdout; changing it will break preview

### Adding New Render Options
1. Add property to `Sv2SvgOptions` type
2. Update `getDefaultSv2SvgOptions()` with default value
3. Add to `loadSv2SvgOptions()` and `saveSv2SvgOptions()` functions
4. Update `buildArgs()` to include new CLI argument
5. Add form control to settings panel HTML in `wrapSvg()`
6. Update `loadSettings()` and `getSettings()` JavaScript functions in webview
7. Add configuration schema to package.json under `sv2svgPreview.renderOptions.*`

### Webview Content
- All HTML generation in `loadingHtml()`, `errorHtml()`, `wrapSvg()`
- Inline styles use VS Code CSS variables for theming
- Scripts must be self-contained (no CSP issues with inline)
- Settings panel uses modern slide-out design with overlay
- Message passing via `vscode.postMessage()` and `onDidReceiveMessage()`

## Dependencies

**Runtime (required by users)**
- Python 3.9+
- `uv` package manager (provides `uvx`)
- `sv2svg` (auto-downloaded by `uvx`)

**Development**
- `@types/node` (v20.0.0)
- `@types/vscode` (v1.80.0)
- `typescript` (v5.3.0)

Minimum VS Code version: 1.80.0
