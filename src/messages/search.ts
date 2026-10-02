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
  return matchesNormalizedMessageSearch(message, needle);
}
export function normalizedMessageFields(message: MessageHeader): string[] {
  return [message.subject, message.author, ...messageRecipients(message)].map(normalizeMessageSearch);
}
export function matchesNormalizedMessageSearch(message: MessageHeader, needle: string): boolean {
  return !needle || [message.subject, message.author, ...messageRecipients(message)]
    .some(value => normalizeMessageSearch(value).includes(needle));
}
