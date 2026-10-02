import type { MessagesApi, MessageDisplayApi, MessageHeader } from "../api/browser";
import { matchesMessageSearch } from "./search";
import { isMessageLocator, messageReference, type MessageLocator } from "./locator";

/** Resolve all exact matches, fail closed on ambiguous copies. Never read MIME. */
export async function resolveMessage(api: MessagesApi, locator: MessageLocator): Promise<MessageHeader | null> {
  if (!isMessageLocator(locator)) return null;
  let page = await api.query({ headerMessageId: locator.headerMessageId, messagesPerPage: 2 });
  const matches = new Map<number, MessageHeader>();
  try {
    for (let pages = 0; pages < 10; pages++) {
      for (const message of page.messages) if (!message.external && message.headerMessageId === locator.headerMessageId) matches.set(message.id, message);
      if (matches.size > 1) return null;
      if (!page.id) return matches.size === 1 ? [...matches.values()][0]! : null;
      page = await api.continueList(page.id);
    }
    return null;
  } finally { if (page.id) await api.abortList(page.id).catch(() => {}); }
}
export async function openMessage(messages: MessagesApi, display: MessageDisplayApi, locator: MessageLocator): Promise<boolean> {
  const current = await resolveMessage(messages, locator);
  if (!current) return false;
  await display.open({ messageId: current.id, location: "tab", active: true });
  return true;
}

export interface MessageSearchResult { messages: MessageHeader[]; limited: boolean }
/** Global metadata queries have no date sort. Bisect full time windows newest-first,
 * then merge/sort locally. Bound API work; explicitly expose truncation to the UI. */
export async function searchMessages(api: MessagesApi, query: string, signal?: AbortSignal, now = Date.now()): Promise<MessageSearchResult> {
  const results = new Map<number, MessageHeader>();
  let calls = 0, limited = false;
  const visit = async (from: number, to: number): Promise<void> => {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (calls >= 64) { limited = true; return; }
    const found = new Map<number, MessageHeader>();
    calls++;
    const page = await api.query({ fromDate: new Date(from), toDate: new Date(to), messagesPerPage: 100 });
    const full = Boolean(page.id);
    try {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      for (const message of page.messages) if (messageReference(message)) found.set(message.id, message);
    } finally { if (page.id) await api.abortList(page.id).catch(() => {}); }
    if (full && to - from > 1) {
      const middle = Math.floor((from + to) / 2);
      await visit(middle, to);
      if (results.size < 50 && !limited) await visit(from, middle);
      // Retain matching sampled candidates when the work budget prevents a
      // complete traversal; the UI explicitly reports this incomplete search.
      if (limited) for (const message of found.values()) if (matchesMessageSearch(message, query)) results.set(message.id, message);
    } else {
      limited ||= full;
      for (const message of found.values()) if (matchesMessageSearch(message, query)) results.set(message.id, message);
    }
  };
  // Start with the recent month; progressively expand backwards without reading
  // the entire mailbox into memory. Include future-dated mail in the first window.
  let to = now + 366 * 86400000, span = 30 * 86400000;
  while (results.size < 50 && to > 0 && !limited) {
    const from = Math.max(0, Math.min(now, to) - span);
    await visit(from, to);
    to = from; span *= 4;
  }
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  return { messages: [...results.values()].sort((a, b) => b.date.getTime() - a.date.getTime() || a.id - b.id).slice(0, 50), limited };
}
