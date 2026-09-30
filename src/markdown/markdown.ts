/**
 * Markdown editing support.
 *
 * `marked` does the parsing (a small, mature, well-tested library — bundled
 * locally, there is no CDN and no network request). On top of it we apply two
 * independent safety layers, because raw HTML inside Markdown is simply not
 * supported in this MVP:
 *
 *  1. `renderer.html` is overridden so every raw HTML token is emitted as
 *     escaped text instead of markup.
 *  2. `sanitizeHtml` runs the result through a strict allowlist in a detached
 *     `<template>` (which never executes scripts nor loads resources) and
 *     re-checks link/image URLs against a scheme allowlist. Passes are repeated
 *     until the serialised output is stable, which also defeats
 *     mutation-XSS style round-trip tricks.
 *
 * `parseMarkdown` therefore returns HTML that is safe to assign via innerHTML.
 */

import { Marked } from "marked";
import type { Tokens } from "marked";

export interface MarkdownParseResult {
  html: string;
  /** True when the input contained raw HTML, which was rendered as text. */
  hadRawHtml: boolean;
}

export interface MarkdownOptions {
  /** Enable GFM tables / strikethrough / autolinks. Default true. */
  gfm?: boolean;
  /** Convert single newlines to <br>. Default false (standard Markdown). */
  breaks?: boolean;
}

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "span", "div",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "sub", "sup", "small",
  "ul", "ol", "li",
  "blockquote", "pre", "code", "kbd", "samp", "var",
  "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
]);

/** Tags whose *content* is also dropped (never merely unwrapped). */
const DROP_CONTENT_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "template", "noscript",
  "svg", "math", "form", "input", "button", "select", "option", "textarea",
  "link", "meta", "base", "frame", "frameset", "applet", "audio", "video", "source", "track",
]);

const ALLOWED_ATTRS_BY_TAG: Record<string, readonly string[]> = {
  a: ["href", "title", "rel"],
  img: ["src", "alt", "title", "width", "height"],
  td: ["align", "colspan", "rowspan"],
  th: ["align", "colspan", "rowspan"],
  col: ["span"],
  colgroup: ["span"],
  ol: ["start", "type"],
  li: ["value"],
  code: ["class"],
};

/** Link relations we are willing to emit ourselves. */
const SAFE_REL_VALUES = new Set(["noreferrer", "noopener", "nofollow", "ugc"]);

/** Attributes allowed on every element (none, but kept for future use). */
const ALLOWED_GLOBAL_ATTRS: readonly string[] = [];

/** `Node.COMMENT_NODE`, inlined so this module does not depend on a DOM global. */
const COMMENT_NODE = 8;

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "moz-extension:"]);

/**
 * Escape the characters that would otherwise start markup in an HTML *text*
 * position.
 *
 * Only `&`, `<` and `>` are escaped. Quotes are deliberately left alone: they are
 * inert inside a text node, and escaping them would be undone anyway when the
 * sanitizer re-parses and re-serialises the markup — which would make its
 * output non-idempotent for no security benefit.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Accept only safe URL schemes. Relative URLs (`./a`, `#anchor`, `notes.html`)
 * are allowed; `javascript:`, `data:`, `blob:`, `file:` and friends are not.
 */
export function isSafeUrl(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (url.length === 0) return false;
  // Strip characters that browsers ignore but that can hide a scheme.
  const compact = url.replace(/[\u0000-\u0020\u007f]+/g, "");

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact);
  if (!schemeMatch) {
    // No scheme at all -> relative reference, which is fine.
    return true;
  }
  const scheme = `${schemeMatch[1]!.toLowerCase()}:`;
  if (!ALLOWED_URL_SCHEMES.has(scheme)) return false;

  try {
    // Validate that it actually parses; guards against pathological input.
    new URL(url, "https://thundernotes.invalid/");
    return true;
  } catch {
    return false;
  }
}

/** Check whether a class attribute value looks like a code-language hint. */
function isSafeCodeClass(value: string): boolean {
  return /^language-[a-z0-9_+#.-]{1,32}$/i.test(value.trim());
}

function sanitizeElement(element: Element): void {
  const tag = element.localName.toLowerCase();

  if (!ALLOWED_TAGS.has(tag)) {
    if (DROP_CONTENT_TAGS.has(tag)) {
      element.remove();
    } else {
      // Unknown but harmless container (e.g. <custom-tag>): unwrap, keep text.
      const parent = element.parentNode;
      if (parent) {
        while (element.firstChild) parent.insertBefore(element.firstChild, element);
        parent.removeChild(element);
      } else {
        element.remove();
      }
    }
    return;
  }

  const perTag = ALLOWED_ATTRS_BY_TAG[tag] ?? [];
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();

    if (!ALLOWED_GLOBAL_ATTRS.includes(name) && !perTag.includes(name)) {
      element.removeAttribute(attribute.name);
      continue;
    }

    const value = attribute.value;

    if ((name === "href" || name === "src") && !isSafeUrl(value)) {
      element.removeAttribute(attribute.name);
      continue;
    }

    if (name === "rel") {
      // Only the relations we would set ourselves; anything else is dropped.
      const relations = value.toLowerCase().split(/\s+/).filter((part) => part.length > 0);
      if (relations.length === 0 || relations.some((part) => !SAFE_REL_VALUES.has(part))) {
        element.removeAttribute(attribute.name);
      }
      continue;
    }

    if (name === "class" && tag === "code" && !isSafeCodeClass(value)) {
      element.removeAttribute(attribute.name);
    }
  }

  // Force safe link behaviour: no opener access, no referrer leaks. Thunderbird
  // opens external links in the user's browser via its own link handler.
  //
  // The value is written verbatim and is itself on the allowlist, so re-running
  // the sanitizer (which it does, to reach a stable result) leaves it untouched
  // instead of stripping it.
  if (tag === "a" && element.hasAttribute("href")) {
    element.setAttribute("rel", "noreferrer noopener");
  }
}

function sanitizeTree(root: ParentNode): void {
  // Snapshot children first: sanitising mutates the tree.
  for (const child of [...root.children]) {
    // Sanitise the deepest nodes first, while the subtree is still attached.
    // (If we unwrapped or removed a node first, its children would already have
    // been moved or orphaned, and recursion would miss them.)
    sanitizeTree(child);
    sanitizeElement(child);
  }

  // Comments carry no meaning in a rendered note and are a classic hiding place
  // for conditional-comment tricks, so remove them outright.
  for (const node of [...root.childNodes]) {
    if (node.nodeType === COMMENT_NODE) node.parentNode?.removeChild(node);
  }
}

/**
 * Parse into a detached `<template>` and sanitize its content fragment.
 *
 * A `<template>` is used for parsing because it is inert: nothing is rendered,
 * fetched or executed. Serialising through a `<div>` wrapper is deliberate —
 * historically, browsers (and some DOM implementations) do not re-serialise a
 * template's content through `template.innerHTML`, which would hand back the
 * original, unsanitized markup.
 */
function parseAndSanitize(html: string, documentRef: Document): string {
  const template = documentRef.createElement("template");
  template.innerHTML = html;
  sanitizeTree(template.content);

  const wrapper = documentRef.createElement("div");
  wrapper.append(...[...template.content.childNodes]);
  return wrapper.innerHTML;
}

/**
 * Sanitize an HTML string against the allowlist above.
 *
 * Safe to call on untrusted input: scripts are dropped, attributes not on the
 * allowlist are removed, and `href`/`src` values must use an allowed scheme.
 */
export function sanitizeHtml(html: string, documentRef: Document = document): string {
  let output = parseAndSanitize(html, documentRef);

  // Repeat until the output is stable: catches markup whose re-parsed form
  // differs from its serialised form (mutation-XSS round-trip tricks).
  for (let pass = 0; pass < 3; pass += 1) {
    const next = parseAndSanitize(output, documentRef);
    if (next === output) break;
    output = next;
  }

  return output;
}

function createMarked(options: MarkdownOptions = {}): Marked {
  const marked = new Marked({
    gfm: options.gfm ?? true,
    breaks: options.breaks ?? false,
    async: false,
  });

  marked.use({
    renderer: {
      // Layer 1: never emit raw HTML coming from the note body.
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
      },
    },
  });

  return marked;
}

const defaultMarked = createMarked();

/**
 * Render Markdown to sanitized HTML.
 *
 * `documentRef` is injectable so the sanitizer can be exercised in Node tests;
 * in the extension the ambient `document` is used.
 */
export function parseMarkdown(
  content: string,
  options: MarkdownOptions = {},
  documentRef: Document = document
): MarkdownParseResult {
  const parser = options.gfm === undefined && options.breaks === undefined ? defaultMarked : createMarked(options);
  const raw = parser.parse(content, { async: false });
  const html = sanitizeHtml(typeof raw === "string" ? raw : "", documentRef);
  return {
    html,
    hadRawHtml: /<[a-zA-Z!/]/.test(content),
  };
}

/** Plain-text rendering, used for tests and for future "copy as text". */
export function markdownToPlainText(content: string): string {
  const marked = createMarked();
  const tokens = marked.lexer(content);
  return marked.parser(tokens).replace(/<[^>]*>/g, "");
}
