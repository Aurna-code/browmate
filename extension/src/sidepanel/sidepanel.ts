/// <reference path="../shared/types.d.ts" />

type ExtractionTrigger = "auto_attach" | "manual_extract" | "preset_load";
type RequestedTarget = Browmate.ExtractionTarget | "auto";

const PRESETS_KEY = "sitePresets";
const LOG_PREFIX = "[Browmate Panel]";

const state: {
  currentIr: Browmate.ExtractedPage | null;
  activeContext: Browmate.ActiveTabContext | null;
  requestToken: number;
  busy: boolean;
  lastAutoExtractContextKey: string | null;
  lastRunSource: ExtractionTrigger | null;
  lastRequestedTarget: RequestedTarget | null;
} = {
  currentIr: null,
  activeContext: null,
  requestToken: 0,
  busy: false,
  lastAutoExtractContextKey: null,
  lastRunSource: null,
  lastRequestedTarget: null,
};

function logInfo(event: string, details?: unknown): void {
  if (typeof details === "undefined") {
    console.info(LOG_PREFIX, event);
    return;
  }
  console.info(LOG_PREFIX, event, details);
}

function logWarn(event: string, details?: unknown): void {
  if (typeof details === "undefined") {
    console.warn(LOG_PREFIX, event);
    return;
  }
  console.warn(LOG_PREFIX, event, details);
}

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
const sourceValueEl = requireElement<HTMLElement>("sourceValue");
const summaryContentEl = requireElement<HTMLDivElement>("summaryContent");
const previewEl = requireElement<HTMLPreElement>("preview");
const targetSelectEl = requireElement<HTMLSelectElement>("targetSelect");
const extractBtn = requireElement<HTMLButtonElement>("extractBtn");
const savePresetBtn = requireElement<HTMLButtonElement>("savePresetBtn");
const loadPresetBtn = requireElement<HTMLButtonElement>("loadPresetBtn");
const exportJsonBtn = requireElement<HTMLButtonElement>("exportJsonBtn");
const exportCsvBtn = requireElement<HTMLButtonElement>("exportCsvBtn");

function emptyContext(): Browmate.ActiveTabContext {
  return {
    tabId: null,
    recordedAt: null,
    url: undefined,
    error: undefined,
  };
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function contextKey(context: Browmate.ActiveTabContext | null): string {
  return [
    context?.tabId ?? "none",
    context?.recordedAt ?? "none",
    context?.url ?? "",
    context?.error ?? "",
  ].join("|");
}

function hasUsableContext(context: Browmate.ActiveTabContext | null): context is Browmate.ActiveTabContext & { tabId: number } {
  return Boolean(context) && !context.error && typeof context.tabId === "number";
}

function describeContext(context: Browmate.ActiveTabContext | null): string {
  if (!context?.url) {
    return "the attached tab";
  }

  try {
    return new URL(context.url).hostname || context.url;
  } catch {
    return context.url;
  }
}

function detachedStatus(context: Browmate.ActiveTabContext | null): string {
  if (context?.error) {
    return context.error;
  }
  return "No tab is attached. Open a normal webpage and click the Browmate toolbar action.";
}

function formatRunSource(trigger: ExtractionTrigger | null): string {
  if (trigger === "auto_attach") {
    return "Auto attach";
  }
  if (trigger === "manual_extract") {
    return "Manual extract";
  }
  if (trigger === "preset_load") {
    return "Preset load";
  }
  return "-";
}

function preferredTargetLabel(target: Browmate.ExtractionTarget | undefined): RequestedTarget {
  return target ?? "auto";
}

function formatRequestedTarget(target: RequestedTarget | null): string {
  if (!target) {
    return "-";
  }
  return target === "auto" ? "Auto detect" : target;
}

function buildStatusPrefix(trigger: ExtractionTrigger): string {
  if (trigger === "auto_attach") {
    return "Auto extract on attach";
  }
  if (trigger === "preset_load") {
    return "Preset load";
  }
  return "Manual extract";
}

function syncControls(): void {
  const attached = hasUsableContext(state.activeContext);
  const hasIr = Boolean(state.currentIr);

  targetSelectEl.disabled = state.busy || !attached;
  extractBtn.disabled = state.busy || !attached;
  loadPresetBtn.disabled = state.busy || !attached;
  savePresetBtn.disabled = state.busy || !hasIr;
  exportJsonBtn.disabled = state.busy || !hasIr;
  exportCsvBtn.disabled = state.busy || !hasIr;
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
  logInfo("activeContext loaded", response.context);
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
      .join("\r\n");
  }

  if (ir.payload.kind === "kv") {
    return [["key", "value"], ...ir.payload.entries.map((entry) => [entry.key, entry.value])]
      .map((row) => row.map((cell) => csvEscape(cell)).join(","))
      .join("\r\n");
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
      .join("\r\n");
  }

  if (ir.payload.kind === "raw_text") {
    const header = ["index", "tag", "text", "text_length", "dom_hint"];
    const rows = ir.payload.blocks.map((block, index) => [
      String(index + 1),
      block.tagName,
      block.text,
      String(block.textLength),
      block.domHint,
    ]);

    return [header, ...rows]
      .map((row) => row.map((cell) => csvEscape(cell)).join(","))
      .join("\r\n");
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
    .join("\r\n");
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
  const lines: string[] = [];
  lines.push(`Run: ${formatRunSource(state.lastRunSource)}.`);

  if (state.lastRequestedTarget === "auto") {
    lines.push(`Auto detect chose ${ir.kind}.`);
  } else if (state.lastRequestedTarget) {
    lines.push(`Requested ${state.lastRequestedTarget}; extracted ${ir.kind}.`);
  }

  if (ir.payload.kind === "table") {
    lines.push(`Detected a table with ${ir.payload.columns.length} columns and ${ir.payload.rows.length} rows.`);
    summaryContentEl.textContent = lines.join(" ");
    return;
  }

  if (ir.payload.kind === "card_list") {
    const itemTitles = ir.payload.items
      .slice(0, 3)
      .map((item) => item.title || item.text || "Untitled")
      .join(" | ");
    lines.push(`Detected ${ir.payload.items.length} cards. Sample: ${itemTitles}`);
    summaryContentEl.textContent = lines.join(" ");
    return;
  }

  if (ir.payload.kind === "kv") {
    const sample = ir.payload.entries
      .slice(0, 4)
      .map((entry) => `${entry.key}: ${entry.value}`)
      .join(" | ");
    lines.push(`Detected ${ir.payload.entries.length} key/value pairs. ${sample}`);
    summaryContentEl.textContent = lines.join(" ");
    return;
  }

  if (ir.payload.kind === "raw_text") {
    const totalTextLength = ir.payload.blocks.reduce((sum, block) => sum + block.textLength, 0);
    const sample = ir.payload.blocks
      .slice(0, 3)
      .map((block) => `${block.tagName}: ${block.text.slice(0, 80)}`)
      .join(" | ");
    lines.push(`Captured ${ir.payload.blocks.length} visible text blocks (${totalTextLength} chars). Sample: ${sample}`);
    summaryContentEl.textContent = lines.join(" ");
    return;
  }

  lines.push(
    `Headline: ${ir.payload.headline}`,
    `Sections: ${ir.payload.sections.length}`,
    `Links: ${ir.payload.links.length}`,
  );
  summaryContentEl.textContent = lines.join("\n");
}

function renderIr(ir: Browmate.ExtractedPage): void {
  state.currentIr = ir;
  siteValueEl.textContent = ir.meta.hostname;
  typeValueEl.textContent = ir.kind;
  timeValueEl.textContent = new Date(ir.meta.extractedAt).toLocaleTimeString();
  sourceValueEl.textContent = formatRunSource(state.lastRunSource);
  previewEl.textContent = JSON.stringify(ir, null, 2);
  renderSummary(ir);
  syncControls();
}

function clearIr(): void {
  state.currentIr = null;
  siteValueEl.textContent = "Not extracted yet";
  typeValueEl.textContent = "-";
  timeValueEl.textContent = "-";
  sourceValueEl.textContent = "-";
  summaryContentEl.textContent = "Extracted records will appear here.";
  previewEl.textContent = "{}";
  syncControls();
}

function buildStartStatus(trigger: ExtractionTrigger, requestedTarget: RequestedTarget, context: Browmate.ActiveTabContext | null): string {
  const prefix = buildStatusPrefix(trigger);
  const target = formatRequestedTarget(requestedTarget);
  return `${prefix} running on ${describeContext(context)} using ${target}...`;
}

function buildSuccessStatus(trigger: ExtractionTrigger, ir: Browmate.ExtractedPage, requestedTarget: RequestedTarget): string {
  const prefix = buildStatusPrefix(trigger);
  const mode = requestedTarget === "auto"
    ? `Auto detect chose ${ir.kind}${ir.kind === "raw_text" ? " as a visible-text fallback." : "."}`
    : `Requested ${requestedTarget}.`;
  const warning = ir.kind === "article" && isWeakArticleResult(ir)
    ? " Warning: article extraction looks partial. Try Article mode on the full post page."
    : "";
  return `${prefix} extracted ${ir.kind} from ${ir.meta.hostname}. ${mode}${warning}`;
}

function isWeakArticleResult(ir: Browmate.ExtractedPage): boolean {
  if (ir.payload.kind !== "article") {
    return false;
  }

  const totalTextLength = ir.payload.sections.reduce((sum, section) => sum + section.length, 0);
  return ir.payload.sections.length < 3 || totalTextLength < 500;
}

async function extract(preferredTarget: Browmate.ExtractionTarget | undefined, trigger: ExtractionTrigger): Promise<void> {
  const requestToken = ++state.requestToken;
  const requestedTarget = preferredTargetLabel(preferredTarget);
  const context = await getActiveContext();

  if (!hasUsableContext(context)) {
    clearIr();
    logWarn("extract requested without attached tab", { trigger, context });
    setStatus("Trying to attach the current tab before extracting...");
  } else {
    setStatus(buildStartStatus(trigger, requestedTarget, context));
  }

  const response = await sendRuntimeMessage<Browmate.RunExtractionRequest, Browmate.RunExtractionResponse>({
    type: "BROWMATE_RUN_EXTRACTION",
    preferredTarget,
  });

  if (!response.ok || !response.ir) {
    logWarn("extraction failed", { error: response.error, preferredTarget, trigger });
    throw new Error(response.error || "Extraction failed.");
  }

  if (requestToken !== state.requestToken) {
    logWarn("stale extraction response ignored", { requestToken, latestRequestToken: state.requestToken });
    return;
  }

  state.lastRunSource = trigger;
  state.lastRequestedTarget = requestedTarget;
  renderIr(response.ir);
  state.lastAutoExtractContextKey = contextKey(await getActiveContext());
  setStatus(buildSuccessStatus(trigger, response.ir, requestedTarget));
  logInfo("extraction success", {
    kind: response.ir.kind,
    url: response.ir.meta.url,
    trigger,
    requestedTarget,
  });
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
    await extract(getPreferredTarget(), "manual_extract");
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
  await extract(preset.target, "preset_load");
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
  await downloadText(filename, `\uFEFF${buildCsv(state.currentIr)}`, "text/csv;charset=utf-8");
  setStatus(`Saved ${filename}.`);
}

async function runAction(action: () => Promise<void>): Promise<void> {
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

function applyActiveContext(
  context: Browmate.ActiveTabContext,
  options: { autoExtract: boolean; source: string },
): void {
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
    clearIr();
    setStatus(`Attached to ${describeContext(context)}. Auto extracting...`);
    void runAction(() => extract(getPreferredTarget(), "auto_attach"));
    return;
  }

  if (!state.currentIr) {
    setStatus(`Attached to ${describeContext(context)}. Click Extract to rerun with ${formatRequestedTarget(preferredTargetLabel(getPreferredTarget()))}.`);
  }
}

function wireEvents(): void {
  extractBtn.addEventListener("click", () => {
    void runAction(() => extract(getPreferredTarget(), "manual_extract"));
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
    if (areaName !== "session" || !changes.activeContext) {
      return;
    }

    const context = (changes.activeContext.newValue as Browmate.ActiveTabContext | undefined) ?? emptyContext();
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
