/// <reference path="../shared/types.d.ts" />

(() => {
  const LOG_PREFIX = "[Browmate Content]";
  const ARTICLE_ROOT_SELECTOR = [
    "article",
    "[role='article']",
    "[role='main']",
    "[itemprop='articleBody']",
    "main",
    ".content",
    ".post",
    ".entry-content",
    ".article-body",
    ".se-main-container",
    "[class*='post-content']",
    "[class*='entry-content']",
    "[class*='article-content']",
    "[class*='story-body']",
    "[class*='story-content']",
    "[class*='post-body']",
    "[class*='entry-body']",
    "[class*='blog-post']",
    "[class*='topic-body']",
    "[class*='message-content']",
    "[class*='markdown-body']",
    "[class*='prose']",
    ".cooked",
  ].join(", ");
  const EXCLUDED_CONTAINER_SELECTOR = [
    "nav",
    "aside",
    "footer",
    "header",
    ".sidebar",
    ".related",
    ".comment",
    ".comments",
  ].join(", ");
  const ARTICLE_MARKER_PATTERN = /(article|post|entry|story|thread|message|content|body|prose|markdown)/;
  const BOILERPLATE_MARKER_PATTERN = /(nav|menu|sidebar|related|recommend|comment|share|social|breadcrumb|promo|advert|ads|cookie|popup|subscribe|newsletter|pagination|toolbar|reaction|rail|footer)/;

  type DetectedCandidate = {
    kind: Browmate.ExtractionTarget;
    payload: Browmate.ExtractionPayload;
    score: number;
    notes: string[];
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

  const globalWindow = window as Window & {
    __browmateContentScriptLoaded?: boolean;
  };

  if (globalWindow.__browmateContentScriptLoaded) {
    logInfo("script already loaded", { url: location.href });
    return;
  }

  globalWindow.__browmateContentScriptLoaded = true;
  logInfo("script loaded", { url: location.href });

  function cleanText(value: string | null | undefined): string {
    return (value ?? "").replace(/\s+/g, " ").trim();
  }

  function wordCount(value: string): number {
    return cleanText(value).split(/\s+/).filter(Boolean).length;
  }

  function isVisible(element: Element | null): element is HTMLElement {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function uniqueTexts(values: string[], limit: number): string[] {
    const seen = new Set<string>();
    const items: string[] = [];

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

  function visibleText(element: Element | null): string {
    if (!isVisible(element)) {
      return "";
    }

    return cleanText(element.innerText || element.textContent || "");
  }

  function normalizeRow(cells: string[], width: number): string[] {
    const row = cells.slice(0, width);
    while (row.length < width) {
      row.push("");
    }
    return row;
  }

  function metaContent(selector: string): string {
    const value = document.querySelector<HTMLMetaElement>(selector)?.content;
    return cleanText(value);
  }

  function pageMeta(): Browmate.PageMeta {
    return {
      url: location.href,
      title: cleanText(document.title) || cleanText(document.querySelector("h1")?.textContent) || location.hostname,
      hostname: location.hostname,
      extractedAt: new Date().toISOString(),
    };
  }

  function markerText(element: Element | null): string {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    const className = typeof element.className === "string" ? element.className : "";
    return [
      element.id,
      className,
      element.getAttribute("role") ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("itemprop") ?? "",
    ].join(" ").toLowerCase();
  }

  function isBoilerplateElement(element: Element | null): boolean {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.matches(EXCLUDED_CONTAINER_SELECTOR)) {
      return true;
    }

    const tagName = element.tagName.toLowerCase();
    if (["nav", "aside", "footer", "form", "header"].includes(tagName)) {
      return true;
    }

    const role = element.getAttribute("role");
    if (role === "navigation" || role === "complementary" || role === "dialog") {
      return true;
    }

    return BOILERPLATE_MARKER_PATTERN.test(markerText(element));
  }

  function hasBoilerplateAncestor(element: Element, root: Element): boolean {
    let current = element.parentElement;
    while (current && current !== root) {
      if (isBoilerplateElement(current)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function linkDensity(element: Element, text: string): number {
    if (!text) {
      return 0;
    }

    const anchorTextLength = Array.from(element.querySelectorAll("a[href]"))
      .map((anchor) => cleanText(anchor.textContent).length)
      .reduce((sum, length) => sum + length, 0);

    return anchorTextLength / Math.max(text.length, 1);
  }

  function isProseBlock(element: Element, text: string): boolean {
    const normalized = cleanText(text);
    const words = wordCount(normalized);
    const tagName = element.tagName.toLowerCase();

    if (!normalized || normalized.length < 20 || normalized.length > 1800 || words < 4) {
      return false;
    }

    if (tagName === "li" && normalized.length < 30) {
      return false;
    }

    if ((normalized.match(/\|/g) ?? []).length >= 3) {
      return false;
    }

    if (linkDensity(element, normalized) > 0.32) {
      return false;
    }

    if (tagName === "div" || tagName === "section") {
      const childCount = Array.from(element.children).filter((child) => child instanceof HTMLElement).length;
      const structuralChildren = Array.from(element.children).filter((child) =>
        ["P", "DIV", "UL", "OL", "LI", "ARTICLE", "SECTION", "ASIDE", "NAV"].includes(child.tagName),
      ).length;

      if (childCount > 10 || structuralChildren > 4) {
        return false;
      }

      if (!/[.!?]/.test(normalized) && words < 10) {
        return false;
      }
    }

    return true;
  }

  function collectArticleBlocks(root: Element, limit: number): string[] {
    const texts: string[] = [];
    const candidates = Array.from(root.querySelectorAll("p, div, section, li, blockquote, pre"));

    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }
      if (candidate !== root && hasBoilerplateAncestor(candidate, root)) {
        continue;
      }
      if (candidate !== root && isBoilerplateElement(candidate)) {
        continue;
      }

      const text = visibleText(candidate);
      if (!isProseBlock(candidate, text)) {
        continue;
      }
      texts.push(text);
    }

    return uniqueTexts(texts, limit);
  }

  function collectLinks(root: Element, limit: number): Array<{ text: string; href: string }> {
    return Array.from(root.querySelectorAll("a[href]"))
      .map((anchor) => ({
        text: cleanText(anchor.textContent),
        href: (anchor as HTMLAnchorElement).href,
      }))
      .filter((link) => link.text && link.href)
      .filter((link, index, items) => items.findIndex((candidate) => candidate.href === link.href) === index)
      .slice(0, limit);
  }

  function headlineElement(): HTMLElement | null {
    const headline = document.querySelector("main h1, article h1, h1");
    return headline instanceof HTMLElement ? headline : null;
  }

  function headlineText(): string {
    return (
      visibleText(headlineElement()) ||
      metaContent('meta[property="og:title"]') ||
      metaContent('meta[name="twitter:title"]') ||
      cleanText(document.title)
    );
  }

  function extractByline(root?: Element): string | undefined {
    const selector = [
      '[rel="author"]',
      '[itemprop="author"]',
      '[class*="author"]',
      '[class*="byline"]',
      '[data-testid*="author"]',
      '.author',
      '.byline',
    ].join(", ");

    const scoped = root?.querySelector(selector) ?? document.querySelector(selector);
    const byline = visibleText(scoped);
    return byline || undefined;
  }

  function collectArticleRootCandidates(headline: HTMLElement | null): HTMLElement[] {
    const roots = new Set<HTMLElement>();

    for (const element of Array.from(document.querySelectorAll(ARTICLE_ROOT_SELECTOR))) {
      if (element instanceof HTMLElement && isVisible(element)) {
        roots.add(element);
      }
    }

    if (headline) {
      let current: HTMLElement | null = headline;
      let depth = 0;
      while (current && depth < 6) {
        if (isVisible(current)) {
          roots.add(current);
        }
        current = current.parentElement;
        depth += 1;
      }
    }

    if (document.body instanceof HTMLElement) {
      roots.add(document.body);
    }

    return Array.from(roots);
  }

  function detailSignalBoost(headline: string, sections: string[], totalTextLength: number): number {
    let score = 0;

    if (headline && headline.length >= 20) {
      score += 12;
    }
    if (sections.length >= 4) {
      score += 12;
    }
    if (totalTextLength >= 900) {
      score += 12;
    }

    return score;
  }

  function detectArticle(): DetectedCandidate | null {
    const headline = headlineText();
    const headlineNode = headlineElement();
    const roots = collectArticleRootCandidates(headlineNode);
    let best: DetectedCandidate | null = null;

    for (const root of roots) {
      const sections = collectArticleBlocks(root, 18);
      const totalTextLength = sections.reduce((sum, section) => sum + section.length, 0);
      const byline = extractByline(root);
      const links = collectLinks(root, 12);
      const notes: string[] = [];
      let score = 0;

      if (root.matches("article, [role='article'], [itemprop='articleBody']")) {
        score += 28;
        notes.push("semantic_root");
      }
      if (root.matches("main")) {
        score += 14;
      }
      if (ARTICLE_MARKER_PATTERN.test(markerText(root))) {
        score += 10;
      }
      if (headlineNode && root.contains(headlineNode)) {
        score += 18;
        notes.push("contains_h1");
      }
      if (headline) {
        score += Math.min(Math.floor(headline.length / 8), 10);
      }
      score += Math.min(sections.length * 6, 54);
      score += Math.min(Math.floor(totalTextLength / 220), 28);
      score += detailSignalBoost(headline, sections, totalTextLength);

      if (byline) {
        score += 8;
      }
      if (root.querySelector("time")) {
        score += 5;
      }

      const anchorCount = root.querySelectorAll("a[href]").length;
      if (anchorCount > sections.length * 4 + 20) {
        score -= 12;
        notes.push("link_heavy");
      }

      const listCount = root.querySelectorAll("ul li, ol li").length;
      if (listCount > sections.length * 2 + 10) {
        score -= 10;
      }

      if (sections.length < 3) {
        score -= 18;
      }
      if (totalTextLength < 420) {
        score -= 20;
      }
      if (isBoilerplateElement(root) && !root.matches("article")) {
        score -= 12;
      }

      if (!headline && sections.length < 3) {
        continue;
      }
      if (totalTextLength < 220) {
        continue;
      }

      const candidate: DetectedCandidate = {
        kind: "article",
        payload: {
          kind: "article",
          headline: headline || location.hostname,
          byline,
          sections,
          links,
        },
        score,
        notes,
      };

      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }

    return best;
  }

  function detectTable(): DetectedCandidate | null {
    let best: DetectedCandidate | null = null;

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
      const rows = bodyRowsSource
        .map((row) => normalizeRow(row, width))
        .filter((row) => row.some(Boolean));

      if (rows.length === 0) {
        continue;
      }

      const score = rows.length * width * 5 + (table.querySelector("thead") ? 6 : 0);
      const candidate: DetectedCandidate = {
        kind: "table",
        payload: {
          kind: "table",
          columns: normalizedColumns,
          rows,
        },
        score,
        notes: [],
      };

      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }

    return best;
  }

  function extractFieldPairs(root: ParentNode): Browmate.KeyValuePair[] {
    const pairs: Browmate.KeyValuePair[] = [];
    const seen = new Set<string>();

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

    const inlineEntries = Array.from(root.querySelectorAll("p, li, div")).slice(0, 24);
    for (const element of inlineEntries) {
      const text = visibleText(element);
      if (!text || !text.includes(":")) {
        continue;
      }

      const [rawKey, ...rest] = text.split(":");
      const key = cleanText(rawKey);
      const value = cleanText(rest.join(":"));
      const signature = `${key}::${value}`;
      if (key && value && key.length <= 40 && value.length <= 220 && !seen.has(signature)) {
        seen.add(signature);
        pairs.push({ key, value });
      }
      if (pairs.length >= 8) {
        break;
      }
    }

    return pairs;
  }

  function detectCardList(articleScore = 0): DetectedCandidate | null {
    let best: DetectedCandidate | null = null;

    const parents = new Set<HTMLElement>();
    for (const node of Array.from(document.querySelectorAll("article, li, div"))) {
      if (isVisible(node) && node.parentElement instanceof HTMLElement) {
        parents.add(node.parentElement);
      }
    }

    for (const parent of parents) {
      if (!isVisible(parent) || isBoilerplateElement(parent)) {
        continue;
      }

      const children = Array.from(parent.children).filter(isVisible);
      if (children.length < 3 || children.length > 20) {
        continue;
      }

      const tagCounts = new Map<string, number>();
      for (const child of children) {
        tagCounts.set(child.tagName, (tagCounts.get(child.tagName) ?? 0) + 1);
      }

      const dominantTag = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1])[0];
      if (!dominantTag || dominantTag[1] < 3) {
        continue;
      }

      const candidateChildren = children.filter((child) => child.tagName === dominantTag[0]).slice(0, 12);
      const items: Browmate.CardItem[] = [];

      for (const child of candidateChildren) {
        const text = visibleText(child);
        if (!text || text.length < 20 || text.length > 900 || linkDensity(child, text) > 0.55) {
          continue;
        }

        const title =
          visibleText(child.querySelector("h1, h2, h3, h4, strong")) ||
          visibleText(child.querySelector("a")) ||
          cleanText(text.split(".")[0]);
        const subtitle =
          visibleText(child.querySelector("h5, h6, small, time")) ||
          visibleText(child.querySelector("p"));
        const href = (child.querySelector("a[href]") as HTMLAnchorElement | null)?.href;
        const fields = extractFieldPairs(child);

        items.push({
          title,
          subtitle: subtitle || undefined,
          text: text.slice(0, 280),
          href: href || undefined,
          fields,
        });
      }

      if (items.length < 3) {
        continue;
      }

      const titledItems = items.filter((item) => item.title).length;
      const linkedItems = items.filter((item) => item.href).length;
      const averageTextLength = items.reduce((sum, item) => sum + (item.text?.length ?? 0), 0) / items.length;
      let score = items.length * 6 + titledItems * 3 + linkedItems;

      if (articleScore >= 60 && items.length <= 6) {
        score -= 30;
      }
      if (articleScore >= 60 && averageTextLength > 140) {
        score -= 18;
      }
      if (candidateChildren.some((child) => child.querySelector("h1"))) {
        score -= 12;
      }

      if (score < 20) {
        continue;
      }

      const candidate: DetectedCandidate = {
        kind: "card_list",
        payload: {
          kind: "card_list",
          items,
        },
        score,
        notes: [],
      };

      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }

    return best;
  }

  function detectKv(articleScore = 0): DetectedCandidate | null {
    const dlPairs = extractFieldPairs(document);
    const entries = dlPairs.length >= 2 ? dlPairs.slice(0, 20) : [];

    const tablePairs: Browmate.KeyValuePair[] = [];
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

    const bestEntries = entries.length >= tablePairs.length ? entries : tablePairs.slice(0, 20);
    if (bestEntries.length < 2) {
      return null;
    }

    const averageKeyLength = bestEntries.reduce((sum, entry) => sum + entry.key.length, 0) / bestEntries.length;
    let score = bestEntries.length * 6;

    if (averageKeyLength > 24) {
      score -= 8;
    }
    if (articleScore >= 60 && bestEntries.length < 8) {
      score -= 24;
    }
    if (score < 12) {
      return null;
    }

    return {
      kind: "kv",
      payload: {
        kind: "kv",
        entries: bestEntries,
      },
      score,
      notes: [],
    };
  }

  function buildIr(payload: Browmate.ExtractionPayload): Browmate.ExtractedPage {
    return {
      kind: payload.kind,
      meta: pageMeta(),
      payload,
    };
  }

  function selectAutoCandidate(): DetectedCandidate {
    const articleCandidate = detectArticle();
    const articleScore = articleCandidate?.score ?? 0;
    const candidates = [
      detectTable(),
      detectCardList(articleScore),
      detectKv(articleScore),
      articleCandidate,
    ].filter((candidate): candidate is DetectedCandidate => Boolean(candidate));

    if (candidates.length === 0) {
      throw new Error("No supported structure found on this page.");
    }

    candidates.sort((left, right) => right.score - left.score);
    let winner = candidates[0];

    if (articleCandidate && shouldPreferArticleCandidate(articleCandidate, winner)) {
      winner = articleCandidate;
    }

    logInfo("auto detect candidates", candidates.map((candidate) => ({
      kind: candidate.kind,
      score: candidate.score,
      notes: candidate.notes,
    })));
    logInfo("auto detect selected", {
      kind: winner.kind,
      score: winner.score,
    });

    return winner;
  }

  function shouldPreferArticleCandidate(articleCandidate: DetectedCandidate, currentWinner: DetectedCandidate): boolean {
    if (articleCandidate.kind !== "article") {
      return false;
    }

    const payload = articleCandidate.payload as Browmate.ArticlePayload;
    const totalTextLength = payload.sections.reduce((sum, section) => sum + section.length, 0);
    const strongArticleSignal = payload.headline.length >= 20 && payload.sections.length >= 4 && totalTextLength >= 600;

    return (
      (strongArticleSignal && articleCandidate.score >= currentWinner.score - 12) ||
      (articleCandidate.score >= 68 && articleCandidate.score >= currentWinner.score - 6)
    );
  }

  function extractPage(preferredTarget?: Browmate.ExtractionTarget): Browmate.ExtractedPage {
    if (preferredTarget === "table") {
      const candidate = detectTable();
      if (!candidate) {
        throw new Error("No table structure found on this page.");
      }
      return buildIr(candidate.payload);
    }

    if (preferredTarget === "card_list") {
      const candidate = detectCardList();
      if (!candidate) {
        throw new Error("No card_list structure found on this page.");
      }
      return buildIr(candidate.payload);
    }

    if (preferredTarget === "kv") {
      const candidate = detectKv();
      if (!candidate) {
        throw new Error("No kv structure found on this page.");
      }
      return buildIr(candidate.payload);
    }

    if (preferredTarget === "article") {
      const candidate = detectArticle();
      if (!candidate) {
        throw new Error("No article structure found on this page.");
      }
      return buildIr(candidate.payload);
    }

    return buildIr(selectAutoCandidate().payload);
  }

  chrome.runtime.onMessage.addListener((message: Browmate.ExtractPageRequest, _sender, sendResponse) => {
    if (message?.type !== "BROWMATE_EXTRACT_PAGE") {
      return false;
    }

    logInfo("extract request received", {
      preferredTarget: message.preferredTarget,
      url: location.href,
    });

    try {
      const ir = extractPage(message.preferredTarget);
      logInfo("extraction success", {
        kind: ir.kind,
        url: ir.meta.url,
      });
      sendResponse({
        type: "BROWMATE_EXTRACT_RESULT",
        ok: true,
        ir,
      } satisfies Browmate.ExtractPageResponse);
    } catch (error) {
      logWarn("extraction failure", {
        error: error instanceof Error ? error.message : error,
        preferredTarget: message.preferredTarget,
        url: location.href,
      });
      sendResponse({
        type: "BROWMATE_EXTRACT_RESULT",
        ok: false,
        error: error instanceof Error ? error.message : "Unknown extraction error.",
      } satisfies Browmate.ExtractPageResponse);
    }

    return false;
  });
})();
