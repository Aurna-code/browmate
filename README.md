# Browmate

`extension/` contains the first usable local-only Chrome Manifest V3 extension for Browmate.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder in this repo.
4. Open a normal website tab (`http://` or `https://`).
5. Click the Browmate toolbar action.
6. Browmate attaches to that tab, opens the side panel, and runs extraction automatically when possible.

## Use the MVP

1. Open a normal webpage you want to extract from.
2. Click the Browmate toolbar action so the side panel attaches to that tab.
3. Wait for the automatic extraction, or click **Extract** if you want to rerun it immediately.
4. Review the preview and raw JSON.
5. Click **Export JSON** or **Export CSV** to save the extracted data locally.
6. Click **Save preset** to store the detected extraction target for the current hostname.
7. Click **Load preset** to re-run extraction using that saved target.

If the panel says no tab is attached, go back to the page you want, then click the Browmate toolbar action again.

## Source layout

- `extension/manifest.json`: MV3 manifest
- `extension/background/`: loadable service worker JS
- `extension/content/`: loadable content script JS
- `extension/sidepanel/`: loadable side panel UI
- `extension/src/`: TypeScript source of the same extension components

## TypeScript note

TypeScript source files are checked in under `extension/src/`, and the matching JS files used by Chrome are checked in under `extension/`.

If you want to wire in a compiler later, start from `extension/tsconfig.json`.

## Debugging

If extraction fails:

1. Open `chrome://extensions`.
2. Find **Browmate** and inspect **Errors** first.
3. Click **service worker** under Browmate to inspect the background logs.
4. Open the target page's DevTools console to inspect content-script logs.

Useful log prefixes:

- `[Browmate SW]` for toolbar click, context attach, `sidePanel.open`, `executeScript`, and `tabs.sendMessage`
- `[Browmate Panel]` for side panel state and extraction UI flow
- `[Browmate Content]` for content-script load and extraction success/failure
