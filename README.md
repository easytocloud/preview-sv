# Preview .sv (VS Code)

Preview SystemVerilog (`.sv`) files as schematics using `sv2svg` via `uvx`.

- Opens a webview panel to the side (like Markdown Preview).
- Runs `uvx sv2svg <file> -o -` and displays the resulting SVG from stdout.
- Auto-refreshes on save; optional live preview while typing.

## Usage

- Open any `.sv` file
- Run command: `SV2SVG: Open Preview to the Side`
- Edit and save the file to re-render (default).

## Settings

- `sv2svgPreview.runner` (default: `uvx`)
- `sv2svgPreview.command` (default: `sv2svg`)
- `sv2svgPreview.args` (array, optional, default `["-o","-"]`)
- `sv2svgPreview.runnerArgs` (array, optional; e.g., `["--refresh"]`)
- `sv2svgPreview.onSave` ("refresh" | "off")
- `sv2svgPreview.onChange` (boolean, experimental)
- `sv2svgPreview.excludePattern` (regex string; default `.*_tb\.sv$`)
- `sv2svgPreview.renderTimeoutMs` (number)

## Build/Run

- `npm install`
- Press F5 to launch the Extension Host (watch build configured)

## Notes

- Requires a trusted workspace to execute external tools.
- Live preview writes a temp file with unsaved content to render safely; it is removed afterwards.
- If `uvx` or `sv2svg` are not on PATH, adjust settings accordingly.
