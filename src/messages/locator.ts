/** Durable metadata only. Runtime numeric IDs never enter notes or Markdown. */
import type { Note } from "../notes/model";
import type { MessageHeader } from "../api/browser";

export interface MessageLocator { version: 1; headerMessageId: string }
export interface MessageReference { locator: MessageLocator; subject: string }
export const MESSAGE_SCHEME = "thundernotes-message:";
export const PRIMARY_MESSAGE_KEY = "thundernotes.primaryMessage.v1";

export function isMessageLocator(value: unknown): value is MessageLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return Object.keys(raw).length === 2 && raw.version === 1 && typeof raw.headerMessageId === "string" &&
    raw.headerMessageId.length > 0 && raw.headerMessageId.length <= 998 && !/[\s<>\u0000-\u001f\u007f]/.test(raw.headerMessageId);
}
export function messageReference(header: MessageHeader): MessageReference | null {
  const locator = { version: 1 as const, headerMessageId: header.headerMessageId };
  return !header.external && isMessageLocator(locator) ? { locator, subject: header.subject ?? "" } : null;
}
export function isMessageReference(value: unknown): value is MessageReference {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return Object.keys(raw).length === 2 && isMessageLocator(raw.locator) && typeof raw.subject === "string" && raw.subject.length <= 100_000;
}
export function encodeMessageLocator(locator: MessageLocator): string {
  if (!isMessageLocator(locator)) throw new Error("Invalid message locator");
  const payload = encodeURIComponent(locator.headerMessageId).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${MESSAGE_SCHEME}v1/${payload}`;
}
export function decodeMessageLocator(uri: string): MessageLocator | null {
  if (!uri.startsWith(`${MESSAGE_SCHEME}v1/`) || uri.length > 4000) return null;
  try {
    const locator = { version: 1 as const, headerMessageId: decodeURIComponent(uri.slice(`${MESSAGE_SCHEME}v1/`.length)) };
    return isMessageLocator(locator) && encodeMessageLocator(locator) === uri ? locator : null;
  } catch { return null; }
}
export function primaryMessage(note: Note): MessageReference | null {
  const value = note.meta?.[PRIMARY_MESSAGE_KEY];
  return isMessageReference(value) ? value : null;
}
export function primaryOwner(notes: readonly Note[], locator: MessageLocator): Note | null {
  const owners = notes.filter(note => primaryMessage(note)?.locator.headerMessageId === locator.headerMessageId);
  if (owners.length > 1) throw new MessageRelationConflictError();
  return owners[0] ?? null;
}
export class MessageRelationConflictError extends Error {
  constructor() { super("Multiple notes would own the same primary message relation."); this.name = "MessageRelationConflictError"; }
}
export function validatePrimaryRelations(notes: readonly Note[]): void {
  const keys = new Set<string>();
  for (const note of notes) {
    const key = primaryMessage(note)?.locator.headerMessageId;
    if (!key) continue;
    if (keys.has(key)) throw new MessageRelationConflictError();
    keys.add(key);
  }
}
export function inlineMessageLink(reference: MessageReference): string {
  const label = (reference.subject || "(No subject)").replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]()<>!#|~&:@]/g, "\\$&");
  return `[${label}](${encodeMessageLocator(reference.locator)})`;
}
