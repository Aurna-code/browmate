/// <reference path="../shared/types.d.ts" />

const ACTIVE_CONTEXT_KEY = "activeContext";

function emptyContext(): Browmate.ActiveTabContext {
  return {
    tabId: null,
    recordedAt: null,
    url: undefined,
    error: undefined,
  };
}

async function setActiveContext(context: Browmate.ActiveTabContext): Promise<void> {
  await chrome.storage.session.set({
    [ACTIVE_CONTEXT_KEY]: context,
  });
}

async function getStoredContext(): Promise<Browmate.ActiveTabContext> {
  const result = await chrome.storage.session.get(ACTIVE_CONTEXT_KEY);
  return (result[ACTIVE_CONTEXT_KEY] as Browmate.ActiveTabContext | undefined) ?? emptyContext();
}

function sendMessageToTab<TRequest, TResponse>(tabId: number, message: TRequest): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: TResponse) => {
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
}).catch((error: unknown) => {
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
    const context = result[ACTIVE_CONTEXT_KEY] as Browmate.ActiveTabContext | undefined;
    if (context?.tabId !== tabId) {
      return;
    }

    return setActiveContext({
      tabId: null,
      recordedAt: new Date().toISOString(),
      error: "The previously selected tab was closed.",
    });
  }).catch(() => {
    // Ignore storage cleanup failures for removed tabs.
  });
});

chrome.runtime.onMessage.addListener((
  message: Browmate.ActiveContextRequest | Browmate.RunExtractionRequest,
  _sender,
  sendResponse,
) => {
  if (message?.type === "BROWMATE_GET_ACTIVE_CONTEXT") {
    getStoredContext()
      .then((context) => {
        sendResponse({
          type: "BROWMATE_ACTIVE_CONTEXT",
          context,
        } satisfies Browmate.ActiveContextResponse);
      })
      .catch(() => {
        sendResponse({
          type: "BROWMATE_ACTIVE_CONTEXT",
          context: emptyContext(),
        } satisfies Browmate.ActiveContextResponse);
      });

    return true;
  }

  if (message?.type === "BROWMATE_RUN_EXTRACTION") {
    getStoredContext()
      .then(async (context) => {
        if (context.error) {
          sendResponse({
            type: "BROWMATE_RUN_EXTRACTION_RESULT",
            ok: false,
            error: context.error,
          } satisfies Browmate.RunExtractionResponse);
          return;
        }

        if (typeof context.tabId !== "number") {
          sendResponse({
            type: "BROWMATE_RUN_EXTRACTION_RESULT",
            ok: false,
            error: "Click the Browmate toolbar action on a page before extracting.",
          } satisfies Browmate.RunExtractionResponse);
          return;
        }

        await chrome.scripting.executeScript({
          target: { tabId: context.tabId },
          files: ["content/content-script.js"],
        });

        const extraction = await sendMessageToTab<Browmate.ExtractPageRequest, Browmate.ExtractPageResponse>(
          context.tabId,
          {
            type: "BROWMATE_EXTRACT_PAGE",
            preferredTarget: message.preferredTarget,
          },
        );

        sendResponse({
          type: "BROWMATE_RUN_EXTRACTION_RESULT",
          ok: extraction.ok,
          ir: extraction.ir,
          error: extraction.error,
        } satisfies Browmate.RunExtractionResponse);
      })
      .catch((error: unknown) => {
        const messageText = error instanceof Error ? error.message : "Extraction bridge failed.";
        sendResponse({
          type: "BROWMATE_RUN_EXTRACTION_RESULT",
          ok: false,
          error: messageText.includes("Cannot access")
            ? "Chrome blocked access to this page. Try a normal website tab."
            : messageText,
        } satisfies Browmate.RunExtractionResponse);
      });

    return true;
  }

  return false;
});
