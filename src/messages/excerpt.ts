import type { MessagesApi } from "../api/browser";

export const MESSAGE_EXCERPT_LENGTH = 450;
const INPUT_LIMIT = 32000;
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©" };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? match;
    const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
/** Text-only tokenizer: never create a DOM from email HTML or load its resources.
 * Deliberately not a browser renderer; drop non-readable sections and formatting. */
export function htmlExcerptText(html: string): string {
  let result = "", suppressed: string | null = null;
  for (const token of html.slice(0, INPUT_LIMIT).matchAll(/<!--[\s\S]*?(?:-->|$)|<(?:"[^"]*"|'[^']*'|[^'">])*?>|[^<]+|</g)) {
    const value = token[0];
    if (value.startsWith("<!--")) continue;
    if (value.startsWith("<")) {
      const tag = /^<\s*(\/?)\s*([a-z][\w:-]*)/i.exec(value);
      if (!tag) continue;
      const name = tag[2]!.toLowerCase();
      if (suppressed) { if (tag[1] && name === suppressed) suppressed = null; continue; }
      if (!tag[1] && ["script", "style", "head", "noscript", "template", "iframe", "object", "svg"].includes(name)) { suppressed = name; continue; }
      if (["br", "p", "div", "li", "tr", "blockquote", "h1", "h2", "h3", "pre"].includes(name)) result += "\n";
    } else if (!suppressed) result += decodeEntities(value);
  }
  return result;
}
export function normalizeExcerpt(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\t\f\v \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const chars = Array.from(clean);
  return chars.length <= MESSAGE_EXCERPT_LENGTH ? clean : chars.slice(0, MESSAGE_EXCERPT_LENGTH - 1).join("").trimEnd() + "…";
}
export async function readMessageExcerpt(api: MessagesApi, id: number): Promise<string> {
  if (!api.listInlineTextParts) throw new Error("Inline text unavailable");
  const parts = await api.listInlineTextParts(id);
  const plain = parts.filter(part => part.contentType.toLowerCase() === "text/plain");
  const selected = plain.length ? plain : parts.filter(part => part.contentType.toLowerCase() === "text/html");
  let text = "";
  for (const part of selected.slice(0, 8)) {
    text += (plain.length ? part.content.slice(0, INPUT_LIMIT) : htmlExcerptText(part.content)) + "\n\n";
    if (Array.from(normalizeExcerpt(text)).length >= MESSAGE_EXCERPT_LENGTH) break;
  }
  const excerpt = normalizeExcerpt(text); if (!excerpt) throw new Error("No readable inline text");
  return excerpt;
}
