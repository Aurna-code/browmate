/// <reference path="../shared/types.d.ts" />

type SelectValue = Browmate.ExtractionTarget | "auto";

const PRESETS_KEY = "sitePresets";

const state: {
  currentIr: Browmate.ExtractedPage | null;
  activeContext: Browmate.ActiveTabContext | null;
  requestToken: number;
} = {
  currentIr: null,
  activeContext: null,
  requestToken: 0,
};

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}

const statusEl = requireElement<HTMLParagraphElement>("status");
const siteValueEl = requireElement<HTMLElement>("siteValue");
const typeValueEl = requireElement<HTMLElement>("typeValue");
const timeValueEl = requireElement<HTMLElement>("timeValue");
const summaryContentEl = requireElement<HTMLDivElement>("summaryContent");
const previewEl = requireElement<HTMLPreElement>("preview");
const targetSelectEl = requireElement<HTMLSelectElement>("targetSelect");
const extractBtn = requireElement<HTMLButtonElement>("extractBtn");
const savePresetBtn = requireElement<HTMLButtonElement>("savePresetBtn");
const loadPresetBtn = requireElement<HTMLButtonElement>("loadPresetBtn");
const exportJsonBtn = requireElement<HTMLButtonElement>("exportJsonBtn");
const exportCsvBtn = requireElement<HTMLButtonElement>("exportCsvBtn");

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function setControlsDisabled(disabled: boolean): void {
  extractBtn.disabled = disabled;
  savePresetBtn.disabled = disabled;
  loadPresetBtn.disabled = disabled;
  exportJsonBtn.disabled = disabled;
  exportCsvBtn.disabled = disabled;
  targetSelectEl.disabled = disabled;
}

function getPreferredTarget(): Browmate.ExtractionTarget | undefined {
  return targetSelectEl.value === "auto" ? undefined : (targetSelectEl.value as Browmate.ExtractionTarget);
}

function setSelectedTarget(target: Browmate.ExtractionTarget): void {
  targetSelectEl.value = target;
}

function sendRuntimeMessage<TRequest, TResponse>(message: TRequest): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: TResponse) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function getActiveContext(): Promise<Browmate.ActiveTabContext> {
  const response = await sendRuntimeMessage<Browmate.ActiveContextRequest, Browmate.ActiveContextResponse>({
    type: "BROWMATE_GET_ACTIVE_CONTEXT",
  });
  state.activeContext = response.context;
  return response.context;
}

function csvEscape(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ").trim();
  if (/[",]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function buildCsv(ir: Browmate.ExtractedPage): string {
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
    const fieldKeys = Array.from(
      new Set(ir.payload.items.flatMap((item) => item.fields.map((field) => field.key))),
    );
    const header = ["title", "subtitle", "text", "href", ...fieldKeys];
    const rows = ir.payload.items.map((item) => {
      const fieldMap = new Map(item.fields.map((field) => [field.key, field.value]));
      return [
        item.title,
        item.subtitle ?? "",
        item.text ?? "",
        item.href ?? "",
        ...fieldKeys.map((key) => fieldMap.get(key) ?? ""),
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
    ir.payload.byline ?? "",
    String(index + 1),
    section,
    linkSummary,
  ]);

  return [header, ...rows]
    .map((row) => row.map((cell) => csvEscape(cell)).join(","))
    .join("\n");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function downloadText(filename: string, contents: string, mimeType: string): Promise<void> {
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

function renderSummary(ir: Browmate.ExtractedPage): void {
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

function renderIr(ir: Browmate.ExtractedPage): void {
  state.currentIr = ir;
  siteValueEl.textContent = ir.meta.hostname;
  typeValueEl.textContent = ir.kind;
  timeValueEl.textContent = new Date(ir.meta.extractedAt).toLocaleTimeString();
  previewEl.textContent = JSON.stringify(ir, null, 2);
  renderSummary(ir);
}

function clearIr(): void {
  state.currentIr = null;
  siteValueEl.textContent = "Not extracted yet";
  typeValueEl.textContent = "-";
  timeValueEl.textContent = "-";
  summaryContentEl.textContent = "Extracted records will appear here.";
  previewEl.textContent = "{}";
}

function ensureUsableContext(context: Browmate.ActiveTabContext): number {
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

async function extract(preferredTarget?: Browmate.ExtractionTarget): Promise<void> {
  const requestToken = ++state.requestToken;
  setStatus("Extracting visible content from the current tab...");
  const context = await getActiveContext();
  ensureUsableContext(context);

  const response = await sendRuntimeMessage<Browmate.RunExtractionRequest, Browmate.RunExtractionResponse>({
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

async function readPresets(): Promise<Record<string, Browmate.SitePreset>> {
  const result = await chrome.storage.local.get(PRESETS_KEY);
  return (result[PRESETS_KEY] as Record<string, Browmate.SitePreset> | undefined) ?? {};
}

async function savePreset(): Promise<void> {
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

async function loadPreset(): Promise<void> {
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

async function exportJson(): Promise<void> {
  if (!state.currentIr) {
    throw new Error("Extract a page before exporting.");
  }

  const filename = `${slugify(state.currentIr.meta.hostname)}-${state.currentIr.kind}.json`;
  await downloadText(filename, JSON.stringify(state.currentIr, null, 2), "application/json");
  setStatus(`Saved ${filename}.`);
}

async function exportCsv(): Promise<void> {
  if (!state.currentIr) {
    throw new Error("Extract a page before exporting.");
  }

  const filename = `${slugify(state.currentIr.meta.hostname)}-${state.currentIr.kind}.csv`;
  await downloadText(filename, buildCsv(state.currentIr), "text/csv");
  setStatus(`Saved ${filename}.`);
}

async function runAction(action: () => Promise<void>): Promise<void> {
  try {
    setControlsDisabled(true);
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unexpected error.");
  } finally {
    setControlsDisabled(false);
  }
}

function wireEvents(): void {
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

function watchActiveContext(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session" || !changes.activeContext?.newValue) {
      return;
    }

    state.activeContext = changes.activeContext.newValue as Browmate.ActiveTabContext;
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
