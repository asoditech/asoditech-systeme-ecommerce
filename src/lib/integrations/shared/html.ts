import "server-only";

// "li"'s own break comes entirely from LIST_ITEM_OPEN below (each item
// opens with its own "\n• ") — it's deliberately excluded here, or a
// closing </li> would add a second, blank-line-producing break on top of
// the next item's, splitting a tight bullet list with stray blank lines.
const BLOCK_CLOSE_TAGS = /<\/(p|div|section|article|header|footer|h[1-6]|tr|blockquote)\s*>/gi;
const LIST_ITEM_OPEN = /<li[^>]*>/gi;
const LINE_BREAK_TAG = /<br\s*\/?>/gi;
const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#0?39;": "'",
  "&apos;": "'",
};

/**
 * Strips markup from an externally-sourced HTML field (a product
 * description) down to plain, readable text — but preserves its
 * paragraph/list-item structure as newlines rather than flattening
 * everything to one line, so the product page can render it as actual
 * paragraphs instead of a single wall of text (Phase: product-page
 * redesign). This app never renders raw HTML from an external source (no
 * `dangerouslySetInnerHTML` anywhere — see
 * docs/adr/0004-integration-architecture.md's security posture); a
 * WooCommerce/Shopify product description is free-text `<p>`/page-builder
 * markup, not something this system controls, so it is flattened at
 * import time rather than escaped-and-shown-as-tags at render time.
 * Shared by both provider mappers so the two integrations can't quietly
 * diverge on this again — see docs/adr/0010-woocommerce-integration.md
 * and docs/adr/0011-shopify-integration.md.
 */
export function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;

  let text = html
    .replace(LINE_BREAK_TAG, "\n")
    .replace(LIST_ITEM_OPEN, "\n• ")
    .replace(BLOCK_CLOSE_TAGS, "\n\n")
    .replace(/<[^>]+>/g, " "); // every remaining tag (inline formatting, images, etc.)

  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    text = text.replace(new RegExp(entity, "gi"), char);
  }

  // Collapse horizontal whitespace within each line, then cap consecutive
  // blank lines at one (never more than a single paragraph gap).
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text || null;
}
