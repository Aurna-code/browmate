const PRESETS_KEY = "sitePresets";

const state = {
  currentIr: null,
  activeContext: null,
  requestToken: 0,
};

function requireElement(id) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}

const statusEl = requireElement("status");
const siteValueEl = requireElement("siteValue");
const typeValueEl = requireElement("typeValue");
const timeValueEl = requireElement("timeValue");
const summaryContentEl = requireElement("summaryContent");
const previewEl = requireElement("preview");
const targetSelectEl = requireElement("targetSelect");
const extractBtn = requireElement("extractBtn");
const savePresetBtn = requireElement("savePresetBtn");
const loadPresetBtn = requireElement("loadPresetBtn");
const exportJsonBtn = requireElement("exportJsonBtn");
const exportCsvBtn = requireElement("exportCsvBtn");

function setStatus(message) {
  statusEl.textContent = message;
}

function setControlsDisabled(disabled) {
  extractBtn.disabled = disabled;
  savePresetBtn.disabled = disabled;
  loadPresetBtn.disabled = disabled;
  exportJsonBtn.disabled = disabled;
  exportCsvBtn.disabled = disabled;
  targetSelectEl.disabled = disabled;
}

function getPreferredTarget() {
  return targetSelectEl.value === "auto" ? void 0 : targetSelectEl.value;
}

function setSelectedTarget(target) {
  targetSelectEl.value = target;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function getActiveContext() {
  const response = await sendRuntimeMessage({
    type: "BROWMATE_GET_ACTIVE_CONTEXT",
  });
  state.activeContext = response.context;
  return response.context;
}

function csvEscape(value) {
  const normalized = value.replace(/\r?\n/g, " ").trim();
  if (/[",]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function buildCsv(ir) {
  if (ir.payload.kind === "table") {
    return [ir.payload.columns, ...ir.payload.rows]
      .map((row) => row.map((cell) => csvEscape(cell)).join(","))
      .join("\n");
  }

  if (ir.payload.kind === "kv") {
    return [["key", "value"], ...ir.payload.entries.map((entry) => [entry.key, entry.value])]
      .map((row) => row.map((cell) => csvEscape(cell)).join(","))
      .join("\n");
  }

  if (ir.payload.kind === "card_list") {
    const fieldKeys = Array.from(new Set(ir.payload.items.flatMap((item) => item.fields.map((field) => field.key))));
    const header = ["title", "subtitle", "text", "href", ...fieldKeys];
    const rows = ir.payload.items.map((item) => {
      const fieldMap = new Map(item.fields.map((field) => [field.key, field.value]));
      return [
        item.title,
        item.subtitle || "",
        item.text || "",
        item.href || "",
        ...fieldKeys.map((key) => fieldMap.get(key) || ""),
      ];
    });
    return [header, ...rows]
      .map((row) => row.map((cell) => csvEscape(cell)).join(","))
      .join("\n");
  }

  const header = ["headline", "byline", "section_index", "section_text", "links"];
  const linkSummary = ir.payload.links.map((link) => `${link.text} (${link.href})`).join(" | ");
  const rows = (ir.payload.sections.length > 0 ? ir.payload.sections : [""]).map((section, index) => [
    ir.payload.headline,
    ir.payload.byline || "",
    String(index + 1),
    section,
    linkSummary,
  ]);

  return [header, ...rows]
    .map((row) => row.map((cell) => csvEscape(cell)).join(","))
    .join("\n");
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function downloadText(filename, contents, mimeType) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: true,
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function renderSummary(ir) {
  if (ir.payload.kind === "table") {
    summaryContentEl.textContent = `Detected a table with ${ir.payload.columns.length} columns and ${ir.payload.rows.length} rows.`;
    return;
  }

  if (ir.payload.kind === "card_list") {
    const itemTitles = ir.payload.items
      .slice(0, 3)
      .map((item) => item.title || item.text || "Untitled")
      .join(" | ");
    summaryContentEl.textContent = `Detected ${ir.payload.items.length} cards. Sample: ${itemTitles}`;
    return;
  }

  if (ir.payload.kind === "kv") {
    const sample = ir.payload.entries
      .slice(0, 4)
      .map((entry) => `${entry.key}: ${entry.value}`)
      .join(" | ");
    summaryContentEl.textContent = `Detected ${ir.payload.entries.length} key/value pairs. ${sample}`;
    return;
  }

  summaryContentEl.textContent = `Headline: ${ir.payload.headline}\nSections: ${ir.payload.sections.length}\nLinks: ${ir.payload.links.length}`;
}

function renderIr(ir) {
  state.currentIr = ir;
  siteValueEl.textContent = ir.meta.hostname;
  typeValueEl.textContent = ir.kind;
  timeValueEl.textContent = new Date(ir.meta.extractedAt).toLocaleTimeString();
  previewEl.textContent = JSON.stringify(ir, null, 2);
  renderSummary(ir);
}

function clearIr() {
  state.currentIr = null;
  siteValueEl.textContent = "Not extracted yet";
  typeValueEl.textContent = "-";
  timeValueEl.textContent = "-";
  summaryContentEl.textContent = "Extracted records will appear here.";
  previewEl.textContent = "{}";
}

function ensureUsableContext(context) {
  if (context.error) {
    clearIr();
    throw new Error(context.error);
  }

  if (typeof context.tabId !== "number") {
    clearIr();
    throw new Error("Click the Browmate toolbar action on a page before extracting.");
  }

  return context.tabId;
}

async function extract(preferredTarget) {
  const requestToken = ++state.requestToken;
  setStatus("Extracting visible content from the current tab...");
  const context = await getActiveContext();
  ensureUsableContext(context);

  const response = await sendRuntimeMessage({
    type: "BROWMATE_RUN_EXTRACTION",
    preferredTarget,
  });

  if (!response.ok || !response.ir) {
    throw new Error(response.error || "Extraction failed.");
  }

  if (requestToken !== state.requestToken) {
    return;
  }

  renderIr(response.ir);
  setStatus(`Extracted ${response.ir.kind} data from ${response.ir.meta.hostname}.`);
}

async function readPresets() {
  const result = await chrome.storage.local.get(PRESETS_KEY);
  return result[PRESETS_KEY] || {};
}

async function savePreset() {
  if (!state.currentIr) {
    throw new Error("Extract a page before saving a preset.");
  }

  const presets = await readPresets();
  presets[state.currentIr.meta.hostname] = {
    hostname: state.currentIr.meta.hostname,
    target: state.currentIr.kind,
    savedAt: new Date().toISOString(),
  };

  await chrome.storage.local.set({
    [PRESETS_KEY]: presets,
  });

  setStatus(`Saved preset for ${state.currentIr.meta.hostname} using ${state.currentIr.kind}.`);
}

async function loadPreset() {
  if (!state.currentIr) {
    await extract(getPreferredTarget());
  }

  const hostname = state.currentIr?.meta.hostname;
  if (!hostname) {
    throw new Error("No site context is available for preset loading.");
  }

  const presets = await readPresets();
  const preset = presets[hostname];
  if (!preset) {
    throw new Error(`No preset saved for ${hostname}.`);
  }

  setSelectedTarget(preset.target);
  await extract(preset.target);
  setStatus(`Loaded preset for ${hostname} and extracted ${preset.target}.`);
}

async function exportJson() {
  if (!state.currentIr) {
    throw new Error("Extract a page before exporting.");
  }

  const filename = `${slugify(state.currentIr.meta.hostname)}-${state.currentIr.kind}.json`;
  await downloadText(filename, JSON.stringify(state.currentIr, null, 2), "application/json");
  setStatus(`Saved ${filename}.`);
}

async function exportCsv() {
  if (!state.currentIr) {
    throw new Error("Extract a page before exporting.");
  }

  const filename = `${slugify(state.currentIr.meta.hostname)}-${state.currentIr.kind}.csv`;
  await downloadText(filename, buildCsv(state.currentIr), "text/csv");
  setStatus(`Saved ${filename}.`);
}

async function runAction(action) {
  try {
    setControlsDisabled(true);
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unexpected error.");
  } finally {
    setControlsDisabled(false);
  }
}

function wireEvents() {
  extractBtn.addEventListener("click", () => {
    void runAction(() => extract(getPreferredTarget()));
  });

  savePresetBtn.addEventListener("click", () => {
    void runAction(savePreset);
  });

  loadPresetBtn.addEventListener("click", () => {
    void runAction(loadPreset);
  });

  exportJsonBtn.addEventListener("click", () => {
    void runAction(exportJson);
  });

  exportCsvBtn.addEventListener("click", () => {
    void runAction(exportCsv);
  });
}

function watchActiveContext() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session" || !changes.activeContext?.newValue) {
      return;
    }

    state.activeContext = changes.activeContext.newValue;
    void runAction(() => extract(getPreferredTarget()));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  watchActiveContext();
  void runAction(async () => {
    const context = await getActiveContext();
    if (context.error) {
      clearIr();
      setStatus(context.error);
      return;
    }
    if (typeof context.tabId !== "number") {
      clearIr();
      setStatus("Click the Browmate toolbar action on a page to attach the side panel.");
      return;
    }
    await extract(getPreferredTarget());
  });
});
