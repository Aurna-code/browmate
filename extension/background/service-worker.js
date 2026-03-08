const ACTIVE_CONTEXT_KEY = "activeContext";
const LOG_PREFIX = "[Browmate SW]";

let activeContextCache = emptyContext();

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

function logError(event, details) {
  if (typeof details === "undefined") {
    console.error(LOG_PREFIX, event);
    return;
  }
  console.error(LOG_PREFIX, event, details);
}

function emptyContext() {
  return {
    tabId: null,
    recordedAt: null,
    url: void 0,
    error: void 0,
  };
}

function noAttachedTabContext(message = "No tab is attached. Open a normal webpage and click the Browmate toolbar action.") {
  return {
    tabId: null,
    recordedAt: new Date().toISOString(),
    error: message,
  };
}

function getTabUrl(tab) {
  return tab.pendingUrl || tab.url;
}

function getUnsupportedPageError(url) {
  if (!url) {
    return "This tab cannot be used for extraction.";
  }

  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://") ||
    url.startsWith("view-source:")
  ) {
    return "Chrome internal pages do not allow Browmate extraction.";
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "This page is unsupported. Open a normal website tab.";
  }

  return void 0;
}

function buildContextFromTab(tab, options) {
  const recordedAt = options.recordedAt || new Date().toISOString();

  if (!tab || typeof tab.id !== "number") {
    return {
      tabId: null,
      recordedAt,
      error: "This tab cannot be used for extraction.",
    };
  }

  const url = getTabUrl(tab);
  if (options.strictUrl && !url) {
    return {
      tabId: null,
      recordedAt,
      error: "This tab cannot be used for extraction.",
    };
  }

  const unsupportedError = url ? getUnsupportedPageError(url) : void 0;
  if (unsupportedError) {
    return {
      tabId: null,
      recordedAt,
      url,
      error: unsupportedError,
    };
  }

  return {
    tabId: tab.id,
    recordedAt,
    url,
  };
}

async function setActiveContext(context, source) {
  activeContextCache = context;
  logInfo("activeContext stored", {
    source,
    tabId: context.tabId,
    url: context.url,
    error: context.error,
    recordedAt: context.recordedAt,
  });
  await chrome.storage.session.set({
    [ACTIVE_CONTEXT_KEY]: context,
  });
}

async function getStoredContext() {
  if (activeContextCache.recordedAt) {
    logInfo("activeContext loaded", {
      source: "cache",
      tabId: activeContextCache.tabId,
      url: activeContextCache.url,
      error: activeContextCache.error,
      recordedAt: activeContextCache.recordedAt,
    });
    return activeContextCache;
  }

  const result = await chrome.storage.session.get(ACTIVE_CONTEXT_KEY);
  activeContextCache = result[ACTIVE_CONTEXT_KEY] || emptyContext();
  logInfo("activeContext loaded", {
    source: "storage.session",
    tabId: activeContextCache.tabId,
    url: activeContextCache.url,
    error: activeContextCache.error,
    recordedAt: activeContextCache.recordedAt,
  });
  return activeContextCache;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (typeof response === "undefined") {
        reject(new Error("Content script did not respond."));
        return;
      }
      resolve(response);
    });
  });
}

async function openSidePanel(windowId) {
  if (typeof windowId !== "number") {
    logWarn("sidePanel.open skipped", { reason: "missing_window_id" });
    return;
  }

  logInfo("sidePanel.open called", { windowId });
  await chrome.sidePanel.open({ windowId });
}

async function resolveActiveTabContext(source) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const context = tab ? buildContextFromTab(tab, { strictUrl: false }) : noAttachedTabContext();
  await setActiveContext(context, source);
  return context;
}

function isMissingContext(context) {
  return typeof context.tabId !== "number";
}

function normalizeExtractionError(error) {
  const message = error instanceof Error ? error.message : "Extraction bridge failed.";

  if (message.includes("No supported structure found") || message.includes("No table structure found") || message.includes("No card_list structure found") || message.includes("No kv structure found") || message.includes("No article structure found")) {
    return message;
  }

  if (message.includes("Receiving end does not exist") || message.includes("Content script did not respond") || message.includes("The message port closed before a response was received")) {
    return "The content script is not responding on this page. Reload the page and try again.";
  }

  if (message.includes("chrome://") || message.includes("chrome-extension://") || message.includes("edge://")) {
    return "Chrome internal pages do not allow Browmate extraction.";
  }

  if (message.includes("Cannot access") || message.includes("Missing host permission") || message.includes("Cannot access contents of the page")) {
    return "Cannot access this page. Click the Browmate toolbar action on the page and try again.";
  }

  return message;
}

void chrome.sidePanel.setPanelBehavior({
  openPanelOnActionClick: false,
}).then(() => {
  logInfo("sidePanel behavior configured", { openPanelOnActionClick: false });
}).catch((error) => {
  logError("sidePanel behavior failed", error);
});

chrome.action.onClicked.addListener((tab) => {
  const context = buildContextFromTab(tab, { strictUrl: true });
  logInfo("action clicked", {
    tabId: tab.id,
    windowId: tab.windowId,
    url: getTabUrl(tab),
    attachedTabId: context.tabId,
    error: context.error,
  });

  const storePromise = setActiveContext(context, "action_click");
  const openPromise = openSidePanel(tab.windowId).catch((error) => {
    logError("sidePanel.open failed", error);
  });

  void Promise.all([storePromise, openPromise]).catch((error) => {
    logError("action click flow failed", error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void getStoredContext().then((context) => {
    if (context.tabId !== tabId) {
      return;
    }

    logWarn("attached tab removed", { tabId });
    return setActiveContext({
      tabId: null,
      recordedAt: new Date().toISOString(),
      error: "The previously selected tab was closed.",
    }, "tab_removed");
  }).catch((error) => {
    logWarn("tab removal cleanup failed", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message == null ? void 0 : message.type) === "BROWMATE_GET_ACTIVE_CONTEXT") {
    getStoredContext()
      .then((context) => {
        sendResponse({
          type: "BROWMATE_ACTIVE_CONTEXT",
          context,
        });
      })
      .catch((error) => {
        logWarn("activeContext load failed", error);
        sendResponse({
          type: "BROWMATE_ACTIVE_CONTEXT",
          context: emptyContext(),
        });
      });

    return true;
  }

  if ((message == null ? void 0 : message.type) === "BROWMATE_RUN_EXTRACTION") {
    getStoredContext()
      .then(async (storedContext) => {
        let context = storedContext;

        if (isMissingContext(context)) {
          logWarn("run extraction without attached tab", {
            storedError: context.error,
            recordedAt: context.recordedAt,
          });
          context = await resolveActiveTabContext("extract_fallback");
        }

        if (context.error) {
          logWarn("extraction blocked", {
            reason: context.error,
            url: context.url,
          });
          sendResponse({
            type: "BROWMATE_RUN_EXTRACTION_RESULT",
            ok: false,
            error: context.error,
          });
          return;
        }

        if (typeof context.tabId !== "number") {
          sendResponse({
            type: "BROWMATE_RUN_EXTRACTION_RESULT",
            ok: false,
            error: "No tab is attached. Open a normal webpage and click the Browmate toolbar action.",
          });
          return;
        }

        logInfo("executeScript called", {
          tabId: context.tabId,
          files: ["content/content-script.js"],
        });
        await chrome.scripting.executeScript({
          target: { tabId: context.tabId },
          files: ["content/content-script.js"],
        });

        logInfo("tabs.sendMessage called", {
          tabId: context.tabId,
          preferredTarget: message.preferredTarget,
        });
        const extraction = await sendMessageToTab(context.tabId, {
          type: "BROWMATE_EXTRACT_PAGE",
          preferredTarget: message.preferredTarget,
        });

        if (!extraction.ok) {
          logWarn("extraction failed", {
            tabId: context.tabId,
            error: extraction.error,
          });
        } else {
          logInfo("extraction success", {
            tabId: context.tabId,
            kind: extraction.ir?.kind,
            url: extraction.ir?.meta.url,
          });
        }

        sendResponse({
          type: "BROWMATE_RUN_EXTRACTION_RESULT",
          ok: extraction.ok,
          ir: extraction.ir,
          error: extraction.error,
        });
      })
      .catch((error) => {
        const normalizedError = normalizeExtractionError(error);
        logError("extraction bridge failed", {
          error,
          normalizedError,
        });
        sendResponse({
          type: "BROWMATE_RUN_EXTRACTION_RESULT",
          ok: false,
          error: normalizedError,
        });
      });

    return true;
  }

  return false;
});
