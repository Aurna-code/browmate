(() => {
  const globalWindow = window;
  if (globalWindow.__browmateContentScriptLoaded) {
    return;
  }

  globalWindow.__browmateContentScriptLoaded = true;

  function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function uniqueTexts(values, limit) {
    const seen = new Set();
    const items = [];

    for (const value of values) {
      const text = cleanText(value);
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      items.push(text);
      if (items.length >= limit) {
        break;
      }
    }

    return items;
  }

  function visibleText(element) {
    if (!isVisible(element)) {
      return "";
    }

    return cleanText(element.innerText || element.textContent || "");
  }

  function normalizeRow(cells, width) {
    const row = cells.slice(0, width);
    while (row.length < width) {
      row.push("");
    }
    return row;
  }

  function pageMeta() {
    return {
      url: location.href,
      title: cleanText(document.title) || cleanText(document.querySelector("h1")?.textContent) || location.hostname,
      hostname: location.hostname,
      extractedAt: new Date().toISOString(),
    };
  }

  function extractTable() {
    let best = null;
    let bestScore = 0;

    for (const table of Array.from(document.querySelectorAll("table")).filter(isVisible)) {
      const rawRows = Array.from(table.querySelectorAll("tr"))
        .map((row) =>
          Array.from(row.querySelectorAll("th, td"))
            .map((cell) => cleanText(cell.textContent))
            .filter(Boolean),
        )
        .filter((row) => row.length > 0);

      if (rawRows.length < 2) {
        continue;
      }

      let columns = Array.from(table.querySelectorAll("thead th"))
        .map((cell) => cleanText(cell.textContent))
        .filter(Boolean);

      if (columns.length === 0) {
        columns = rawRows[0].map((cell, index) => cell || `Column ${index + 1}`);
      }

      const width = Math.max(columns.length, ...rawRows.map((row) => row.length));
      const normalizedColumns = normalizeRow(
        columns.map((cell, index) => cell || `Column ${index + 1}`),
        width,
      ).map((cell, index) => cell || `Column ${index + 1}`);

      const bodyRowsSource = table.querySelector("thead") ? rawRows : rawRows.slice(1);
      const rows = bodyRowsSource.map((row) => normalizeRow(row, width)).filter((row) => row.some(Boolean));
      if (rows.length === 0) {
        continue;
      }

      const score = rows.length * width;
      if (score > bestScore) {
        bestScore = score;
        best = {
          kind: "table",
          columns: normalizedColumns,
          rows,
        };
      }
    }

    return best;
  }

  function extractFieldPairs(root) {
    const pairs = [];
    const seen = new Set();

    const dlEntries = Array.from(root.querySelectorAll("dt")).slice(0, 8);
    for (const dt of dlEntries) {
      const dd = dt.nextElementSibling;
      const key = visibleText(dt);
      const value = visibleText(dd);
      const signature = `${key}::${value}`;
      if (key && value && !seen.has(signature)) {
        seen.add(signature);
        pairs.push({ key, value });
      }
    }

    const inlineEntries = Array.from(root.querySelectorAll("p, li, div")).slice(0, 20);
    for (const element of inlineEntries) {
      const text = visibleText(element);
      if (!text || !text.includes(":")) {
        continue;
      }

      const [rawKey, ...rest] = text.split(":");
      const key = cleanText(rawKey);
      const value = cleanText(rest.join(":"));
      const signature = `${key}::${value}`;
      if (key && value && key.length <= 40 && value.length <= 200 && !seen.has(signature)) {
        seen.add(signature);
        pairs.push({ key, value });
      }
      if (pairs.length >= 6) {
        break;
      }
    }

    return pairs;
  }

  function extractCardList() {
    let best = null;
    let bestScore = 0;

    const parents = new Set();
    for (const node of Array.from(document.querySelectorAll("article, li, div"))) {
      if (isVisible(node) && node.parentElement instanceof HTMLElement) {
        parents.add(node.parentElement);
      }
    }

    for (const parent of parents) {
      if (!isVisible(parent)) {
        continue;
      }

      const children = Array.from(parent.children).filter(isVisible);
      if (children.length < 3 || children.length > 20) {
        continue;
      }

      const tagCounts = new Map();
      for (const child of children) {
        tagCounts.set(child.tagName, (tagCounts.get(child.tagName) || 0) + 1);
      }

      const dominantTag = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1])[0];
      if (!dominantTag || dominantTag[1] < 3) {
        continue;
      }

      const candidateChildren = children.filter((child) => child.tagName === dominantTag[0]).slice(0, 12);
      const items = [];

      for (const child of candidateChildren) {
        const text = visibleText(child);
        if (!text || text.length < 20 || text.length > 900) {
          continue;
        }

        const title =
          visibleText(child.querySelector("h1, h2, h3, h4, strong")) ||
          visibleText(child.querySelector("a")) ||
          cleanText(text.split(".")[0]);
        const subtitle =
          visibleText(child.querySelector("h5, h6, small, time")) ||
          visibleText(child.querySelector("p"));
        const href = child.querySelector("a[href]")?.href;
        const fields = extractFieldPairs(child);

        items.push({
          title,
          subtitle: subtitle || void 0,
          text: text.slice(0, 280),
          href: href || void 0,
          fields,
        });
      }

      if (items.length < 3) {
        continue;
      }

      const titledItems = items.filter((item) => item.title).length;
      const linkedItems = items.filter((item) => item.href).length;
      const score = items.length * 3 + titledItems * 2 + linkedItems;

      if (score > bestScore) {
        bestScore = score;
        best = {
          kind: "card_list",
          items,
        };
      }
    }

    return best;
  }

  function extractKv() {
    const dlPairs = extractFieldPairs(document);
    if (dlPairs.length >= 2) {
      return {
        kind: "kv",
        entries: dlPairs.slice(0, 20),
      };
    }

    const tablePairs = [];
    for (const table of Array.from(document.querySelectorAll("table")).filter(isVisible)) {
      for (const row of Array.from(table.querySelectorAll("tr")).slice(0, 20)) {
        const cells = Array.from(row.querySelectorAll("th, td"))
          .map((cell) => cleanText(cell.textContent))
          .filter(Boolean);
        if (cells.length === 2) {
          tablePairs.push({
            key: cells[0],
            value: cells[1],
          });
        }
      }
    }

    if (tablePairs.length >= 2) {
      return {
        kind: "kv",
        entries: tablePairs.slice(0, 20),
      };
    }

    return null;
  }

  function extractArticle() {
    const root = document.querySelector("article, main") || document.body;
    const headline = visibleText(document.querySelector("h1")) || cleanText(document.title);
    const byline =
      visibleText(document.querySelector('[rel="author"], [itemprop="author"], .author, .byline')) || void 0;

    const sections = uniqueTexts(
      Array.from(root.querySelectorAll("p, li"))
        .map((node) => visibleText(node))
        .filter((text) => text.length >= 40),
      12,
    );

    const links = Array.from(root.querySelectorAll("a[href]"))
      .map((anchor) => ({
        text: cleanText(anchor.textContent),
        href: anchor.href,
      }))
      .filter((link) => link.text && link.href)
      .filter((link, index, items) => items.findIndex((candidate) => candidate.href === link.href) === index)
      .slice(0, 10);

    if (!headline && sections.length === 0) {
      return null;
    }

    return {
      kind: "article",
      headline: headline || location.hostname,
      byline,
      sections,
      links,
    };
  }

  function buildIr(payload) {
    return {
      kind: payload.kind,
      meta: pageMeta(),
      payload,
    };
  }

  function extractPage(preferredTarget) {
    const extractors = {
      table: extractTable,
      card_list: extractCardList,
      kv: extractKv,
      article: extractArticle,
    };

    if (preferredTarget) {
      const payload = extractors[preferredTarget]();
      if (!payload) {
        throw new Error(`No ${preferredTarget} structure found on this page.`);
      }
      return buildIr(payload);
    }

    for (const target of ["table", "card_list", "kv", "article"]) {
      const payload = extractors[target]();
      if (payload) {
        return buildIr(payload);
      }
    }

    throw new Error("No supported structure found on this page.");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((message == null ? void 0 : message.type) !== "BROWMATE_EXTRACT_PAGE") {
      return false;
    }

    try {
      const ir = extractPage(message.preferredTarget);
      sendResponse({
        type: "BROWMATE_EXTRACT_RESULT",
        ok: true,
        ir,
      });
    } catch (error) {
      sendResponse({
        type: "BROWMATE_EXTRACT_RESULT",
        ok: false,
        error: error instanceof Error ? error.message : "Unknown extraction error.",
      });
    }

    return false;
  });
})();
