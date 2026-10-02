import type { MessageHeader } from "../api/browser";

/** Picker-only recipients; no new persistent snapshot fields. */
export function messageRecipients(message: MessageHeader): string[] {
  return [...new Set([...(message.recipients ?? []), ...(message.ccList ?? []), ...(message.bccList ?? [])])];
}

/** Locale-independent canonical text; preserve punctuation in email addresses. */
export function normalizeMessageSearch(value: string): string {
  return value.normalize("NFC").toLowerCase().trim().replace(/\s+/gu, " ");
}
export function matchesMessageSearch(message: MessageHeader, query: string): boolean {
  const needle = normalizeMessageSearch(query);
  return !needle || [message.subject, message.author, ...messageRecipients(message)]
    .some(value => normalizeMessageSearch(value).includes(needle));
}
