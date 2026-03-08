# Browmate

`extension/` contains the first usable local-only Chrome Manifest V3 extension for Browmate.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder in this repo.
4. Open any page, click the Browmate toolbar action, and the side panel will open.

## Use the MVP

1. In the side panel, click **Extract** to capture the current page into a local IR.
2. Review the preview and raw JSON.
3. Click **Export JSON** or **Export CSV** to save the extracted data locally.
4. Click **Save preset** to store the detected extraction target for the current hostname.
5. Click **Load preset** to re-run extraction using that saved target.

## Source layout

- `extension/manifest.json`: MV3 manifest
- `extension/background/`: loadable service worker JS
- `extension/content/`: loadable content script JS
- `extension/sidepanel/`: loadable side panel UI
- `extension/src/`: TypeScript source of the same extension components

## TypeScript note

TypeScript source files are checked in under `extension/src/`, and the matching JS files used by Chrome are checked in under `extension/`.

If you want to wire in a compiler later, start from `extension/tsconfig.json`.
