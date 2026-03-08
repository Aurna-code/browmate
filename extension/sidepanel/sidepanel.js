const PRESETS_KEY = "sitePresets";
const LOG_PREFIX = "[Browmate Panel]";

const state = {
  currentIr: null,
  activeContext: null,
  requestToken: 0,
  busy: false,
  lastAutoExtractContextKey: null,
};

function logInfo(event, details) {
  if (typeof details === "undefined") {
    console.info(LOG_PREFIX, event);
    return;
  }
  console.info(LOG_PREFIX, event, details);
}

function logWarn(event, details) {
  if (typeof details === "undefined") {
    console.warn(LOG_PREFIX, event);
    return;
  }
  console.warn(LOG_PREFIX, event, details);
}

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

function emptyContext() {
  return {
    tabId: null,
    recordedAt: null,
    url: void 0,
    error: void 0,
  };
}

function setStatus(message) {
  statusEl.textContent = message;
}

function contextKey(context) {
  return [
    context?.tabId ?? "none",
    context?.recordedAt ?? "none",
    context?.url ?? "",
    context?.error ?? "",
  ].join("|");
}

function hasUsableContext(context) {
  return Boolean(context) && !context.error && typeof context.tabId === "number";
}

function describeContext(context) {
  if (!(context?.url)) {
    return "the attached tab";
  }

  try {
    return new URL(context.url).hostname || context.url;
  } catch {
    return context.url;
  }
}

function detachedStatus(context) {
  if (context?.error) {
    return context.error;
  }
  return "No tab is attached. Open a normal webpage and click the Browmate toolbar action.";
}

function syncControls() {
  const attached = hasUsableContext(state.activeContext);
  const hasIr = Boolean(state.currentIr);

  targetSelectEl.disabled = state.busy || !attached;
  extractBtn.disabled = state.busy || !attached;
  loadPresetBtn.disabled = state.busy || !attached;
  savePresetBtn.disabled = state.busy || !hasIr;
  exportJsonBtn.disabled = state.busy || !hasIr;
  exportCsvBtn.disabled = state.busy || !hasIr;
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
  logInfo("activeContext loaded", response.context);
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
  syncControls();
}

function clearIr() {
  state.currentIr = null;
  siteValueEl.textContent = "Not extracted yet";
  typeValueEl.textContent = "-";
  timeValueEl.textContent = "-";
  summaryContentEl.textContent = "Extracted records will appear here.";
  previewEl.textContent = "{}";
  syncControls();
}

async function extract(preferredTarget) {
  const requestToken = ++state.requestToken;
  const context = await getActiveContext();

  if (!hasUsableContext(context)) {
    clearIr();
    logWarn("extract requested without attached tab", context);
    setStatus("Trying to attach the current tab before extracting...");
  } else {
    setStatus(`Extracting visible content from ${describeContext(context)}...`);
  }

  const response = await sendRuntimeMessage({
    type: "BROWMATE_RUN_EXTRACTION",
    preferredTarget,
  });

  if (!response.ok || !response.ir) {
    logWarn("extraction failed", { error: response.error, preferredTarget });
    throw new Error(response.error || "Extraction failed.");
  }

  if (requestToken !== state.requestToken) {
    logWarn("stale extraction response ignored", { requestToken, latestRequestToken: state.requestToken });
    return;
  }

  renderIr(response.ir);
  state.lastAutoExtractContextKey = contextKey(await getActiveContext());
  setStatus(`Extracted ${response.ir.kind} data from ${response.ir.meta.hostname}.`);
  logInfo("extraction success", {
    kind: response.ir.kind,
    url: response.ir.meta.url,
  });
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
    state.busy = true;
    syncControls();
    await action();
  } catch (error) {
    logWarn("panel action failed", error);
    setStatus(error instanceof Error ? error.message : "Unexpected error.");
  } finally {
    state.busy = false;
    syncControls();
  }
}

function applyActiveContext(context, options) {
  state.activeContext = context;
  logInfo("activeContext applied", {
    source: options.source,
    tabId: context.tabId,
    url: context.url,
    error: context.error,
    recordedAt: context.recordedAt,
  });

  if (!hasUsableContext(context)) {
    state.lastAutoExtractContextKey = null;
    clearIr();
    setStatus(detachedStatus(context));
    return;
  }

  syncControls();

  const nextKey = contextKey(context);
  if (options.autoExtract && !state.busy && state.lastAutoExtractContextKey !== nextKey) {
    state.lastAutoExtractContextKey = nextKey;
    setStatus(`Attached to ${describeContext(context)}. Extracting...`);
    void runAction(() => extract(getPreferredTarget()));
    return;
  }

  if (!state.currentIr) {
    setStatus(`Attached to ${describeContext(context)}. Click Extract to capture the page.`);
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
    if (areaName !== "session" || !changes.activeContext) {
      return;
    }

    const context = changes.activeContext.newValue || emptyContext();
    applyActiveContext(context, {
      autoExtract: !state.busy,
      source: "storage.session",
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  watchActiveContext();
  clearIr();
  setStatus("Checking the attached tab...");
  void (async () => {
    try {
      const context = await getActiveContext();
      applyActiveContext(context, {
        autoExtract: true,
        source: "initial_load",
      });
    } catch (error) {
      logWarn("initial context load failed", error);
      setStatus(error instanceof Error ? error.message : "Unable to load the attached tab.");
    }
  })();
});
