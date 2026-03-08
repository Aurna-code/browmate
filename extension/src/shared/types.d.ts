declare namespace Browmate {
  type ExtractionTarget = "table" | "card_list" | "kv" | "article" | "raw_text";

  interface PageMeta {
    url: string;
    title: string;
    hostname: string;
    extractedAt: string;
  }

  interface KeyValuePair {
    key: string;
    value: string;
  }

  interface TablePayload {
    kind: "table";
    columns: string[];
    rows: string[][];
  }

  interface CardItem {
    title: string;
    subtitle?: string;
    text?: string;
    href?: string;
    fields: KeyValuePair[];
  }

  interface CardListPayload {
    kind: "card_list";
    items: CardItem[];
  }

  interface KVPayload {
    kind: "kv";
    entries: KeyValuePair[];
  }

  interface ArticlePayload {
    kind: "article";
    headline: string;
    byline?: string;
    sections: string[];
    links: Array<{
      text: string;
      href: string;
    }>;
  }

  interface RawTextBlock {
    text: string;
    tagName: string;
    domHint: string;
    textLength: number;
  }

  interface RawTextPayload {
    kind: "raw_text";
    blocks: RawTextBlock[];
  }

  type ExtractionPayload =
    | TablePayload
    | CardListPayload
    | KVPayload
    | ArticlePayload
    | RawTextPayload;

  interface ExtractedPage {
    kind: ExtractionTarget;
    meta: PageMeta;
    payload: ExtractionPayload;
  }

  interface SitePreset {
    hostname: string;
    target: ExtractionTarget;
    savedAt: string;
  }

  interface ActiveTabContext {
    tabId: number | null;
    recordedAt: string | null;
    url?: string;
    error?: string;
  }

  interface ExtractPageRequest {
    type: "BROWMATE_EXTRACT_PAGE";
    preferredTarget?: ExtractionTarget;
  }

  interface ExtractPageResponse {
    type: "BROWMATE_EXTRACT_RESULT";
    ok: boolean;
    ir?: ExtractedPage;
    error?: string;
  }

  interface RunExtractionRequest {
    type: "BROWMATE_RUN_EXTRACTION";
    preferredTarget?: ExtractionTarget;
  }

  interface RunExtractionResponse {
    type: "BROWMATE_RUN_EXTRACTION_RESULT";
    ok: boolean;
    ir?: ExtractedPage;
    error?: string;
  }

  interface ActiveContextRequest {
    type: "BROWMATE_GET_ACTIVE_CONTEXT";
  }

  interface ActiveContextResponse {
    type: "BROWMATE_ACTIVE_CONTEXT";
    context: ActiveTabContext;
  }
}
