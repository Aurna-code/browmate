const ACTIVE_CONTEXT_KEY = "activeContext";

function emptyContext() {
  return {
    tabId: null,
    recordedAt: null,
    url: void 0,
    error: void 0,
  };
}

async function setActiveContext(context) {
  await chrome.storage.session.set({
    [ACTIVE_CONTEXT_KEY]: context,
  });
}

async function getStoredContext() {
  const result = await chrome.storage.session.get(ACTIVE_CONTEXT_KEY);
  return result[ACTIVE_CONTEXT_KEY] || emptyContext();
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

void chrome.sidePanel.setPanelBehavior({
  openPanelOnActionClick: true,
}).catch((error) => {
  console.error("Failed to configure side panel behavior.", error);
});

chrome.action.onClicked.addListener(async (tab) => {
  const recordedAt = new Date().toISOString();

  if (typeof tab.id !== "number" || !tab.url) {
    await setActiveContext({
      tabId: null,
      recordedAt,
      error: "This tab cannot be used for extraction.",
    });
    return;
  }

  if (
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("edge://")
  ) {
    await setActiveContext({
      tabId: null,
      recordedAt,
      url: tab.url,
      error: "Chrome internal pages do not allow Browmate extraction.",
    });
    return;
  }

  await setActiveContext({
    tabId: tab.id,
    recordedAt,
    url: tab.url,
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.get(ACTIVE_CONTEXT_KEY).then((result) => {
    const context = result[ACTIVE_CONTEXT_KEY];
    if ((context == null ? void 0 : context.tabId) !== tabId) {
      return;
    }

    return setActiveContext({
      tabId: null,
      recordedAt: new Date().toISOString(),
      error: "The previously selected tab was closed.",
    });
  }).catch(() => {
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
      .catch(() => {
        sendResponse({
          type: "BROWMATE_ACTIVE_CONTEXT",
          context: emptyContext(),
        });
      });

    return true;
  }

  if ((message == null ? void 0 : message.type) === "BROWMATE_RUN_EXTRACTION") {
    getStoredContext()
      .then(async (context) => {
        if (context.error) {
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
            error: "Click the Browmate toolbar action on a page before extracting.",
          });
          return;
        }

        await chrome.scripting.executeScript({
          target: { tabId: context.tabId },
          files: ["content/content-script.js"],
        });

        const extraction = await sendMessageToTab(context.tabId, {
          type: "BROWMATE_EXTRACT_PAGE",
          preferredTarget: message.preferredTarget,
        });

        sendResponse({
          type: "BROWMATE_RUN_EXTRACTION_RESULT",
          ok: extraction.ok,
          ir: extraction.ir,
          error: extraction.error,
        });
      })
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : "Extraction bridge failed.";
        sendResponse({
          type: "BROWMATE_RUN_EXTRACTION_RESULT",
          ok: false,
          error: messageText.includes("Cannot access")
            ? "Chrome blocked access to this page. Try a normal website tab."
            : messageText,
        });
      });

    return true;
  }

  return false;
});
