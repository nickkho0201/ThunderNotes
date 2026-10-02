import { getBrowser } from "../api/browser";
import { primaryMessage, primaryMessageReference, primaryOwner, isMessageLocator, decodeMessageLocator, type MessageLocator, type MessageReference } from "../messages/locator";
import { formatPrimaryMessage } from "../messages/presentation";
import { openMessage, resolveMessage } from "../messages/platform";
import type { MessageIntent } from "../messages/navigation";
import { t } from "../i18n";
import type { NoteStore } from "./store";
import type { EditorView } from "./editor-view";
import { MessagePicker } from "./message-picker";
import { bindMailCommand } from "./mail-command";

/** Page-owned integration: note data remains authoritative in store/repository. */
export function bindMessageNotes(options: {
  store: NoteStore; editor: EditorView; textarea: HTMLTextAreaElement; preview: HTMLElement;
  onMessage: (message: string) => void; showEditor: () => void;
}): void {
  const { store, editor, textarea, preview, onMessage } = options;
  const api = getBrowser(); if (!api?.messages || !api.messageDisplay) return;
  const messages = api.messages, display = api.messageDisplay, document = textarea.ownerDocument;
  const header = document.createElement("div"); header.className = "tn-primary-message"; header.hidden = true;
  const link = document.createElement("button"); link.type = "button"; link.className = "tn-primary-message__link";
  const badge = document.createElement("span"); badge.className = "tn-primary-message__kind"; badge.setAttribute("aria-hidden", "true");
  const identity = document.createElement("span"); identity.className = "tn-primary-message__identity"; link.append(badge, identity);
  const unlink = document.createElement("button"); unlink.type = "button"; unlink.className = "tn-icon-btn tn-primary-message__unlink";
  const unlinkIcon = document.createElement("span"); unlinkIcon.className = "tn-icon tn-icon--close"; unlinkIcon.setAttribute("aria-hidden", "true"); unlink.append(unlinkIcon);
  unlink.title = t("messageUnlink"); unlink.setAttribute("aria-label", t("messageUnlink"));
  header.append(link, unlink);
  document.getElementById("tn-md-mode")?.before(header);
  let renderedKey = "", relationSignature = "", sequence = 0;
  const navigate = async (locator: MessageLocator): Promise<void> => {
    try { if (await openMessage(messages, display, locator)) return; }
    catch { /* Missing, ambiguous and failed display share the unavailable state. */ }
    onMessage(t("messageUnavailableStatus"));
    renderedKey = ""; refreshHeader();
  };
  link.addEventListener("click", () => {
    const note = store.getSelectedNote(), reference = note && primaryMessage(note);
    if (reference) void navigate(reference.locator);
  });
  unlink.addEventListener("click", () => {
    const note = store.getSelectedNote(), reference = note && primaryMessage(note);
    if (!note || !reference || store.isMutationLocked()) return;
    if (!document.defaultView?.confirm(t("messageUnlinkConfirm"))) return;
    // The synchronous dialog does not authorize unlinking a different selection.
    if (store.getSelectedId() !== note.id || primaryMessage(store.getSelectedNote()!)?.locator.headerMessageId !== reference.locator.headerMessageId) return;
    store.unlinkPrimary(note.id); store.flushPending();
  });
  const refreshHeader = (): void => {
    const note = store.getSelectedNote(), reference = note && primaryMessage(note);
    const key = note && reference ? `${note.id}:${JSON.stringify(reference)}` : "";
    if (key === renderedKey) return; renderedKey = key;
    const current = ++sequence; header.hidden = !reference;
    if (!reference) return;
    const present = (snapshot: MessageReference, unavailable = false): void => {
      const formatted = formatPrimaryMessage(snapshot, unavailable);
      badge.textContent = formatted.badge; badge.title = formatted.kind;
      identity.textContent = formatted.text; link.title = formatted.title; link.setAttribute("aria-label", formatted.title);
      header.classList.toggle("is-unavailable", unavailable);
    };
    present(reference);
    void resolveMessage(messages, reference.locator).catch(() => null).then(found => {
      if (current !== sequence) return;
      if (!found) present(reference, true);
      else { const fresh = primaryMessageReference(found); if (fresh) store.enrichPrimarySnapshot(note!.id, fresh); }
    });
  };
  const internalClick = (event: MouseEvent): void => {
    if (preview.hidden || store.getSelectedNote()?.format !== "markdown") return;
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || !preview.contains(anchor)) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("thundernotes-message:")) return;
    event.preventDefault(); event.stopPropagation();
    if (event.type !== "click") return;
    const locator = decodeMessageLocator(href); if (locator) void navigate(locator); else onMessage(t("messageUnavailableStatus"));
  };
  preview.addEventListener("click", internalClick);
  preview.addEventListener("auxclick", internalClick);
  preview.addEventListener("contextmenu", internalClick);
  const picker = new MessagePicker(document, messages);
  const commands = bindMailCommand({ textarea, enabled: () => store.getSelectedNote()?.format === "markdown" && !store.isMutationLocked(),
    noteId: () => store.getSelectedId(), pick: () => picker.open(), mutate: edit => editor.applySourceEdit(edit) });
  const notify = (): void => { void api.runtime.sendMessage({ type: "thundernotes:mail-changed" }).catch(() => {}); };
  store.subscribe(event => {
    if (event.type === "selection" || event.type === "notes") refreshHeader();
    if (event.type === "selection") commands.reset();
    if (event.type === "notes") {
      const next = store.getNotes().map(entry => `${entry.note.id}:${primaryMessage(entry.note)?.locator.headerMessageId ?? ""}`).join("\n");
      if (next !== relationSignature) { relationSignature = next; notify(); }
    }
    if (event.type === "save-status" && store.getSaveStatus() === "saved") notify();
  });
  const page = crypto.randomUUID(); let draining = false;
  const drain = async (): Promise<void> => {
    if (draining || store.isMutationLocked()) return; draining = true;
    try {
      for (let count = 0; count < 100; count++) {
        const tab = await api.tabs?.getCurrent?.();
        const response = await api.runtime.sendMessage({ type: "thundernotes:mail-next", page, windowId: tab?.windowId }) as { ok?: boolean; value?: MessageIntent } | undefined;
        if (!response?.ok || !response.value) break;
        const intent = response.value;
        if (store.isMutationLocked()) break;
        try {
          const result = await store.openPrimaryNote(intent.reference);
          options.showEditor(); if (result.created) editor.focus(); else editor.focusOpened();
          refreshHeader(); notify();
        } catch { onMessage(t("messageNoteError")); break; }
        const ack = await api.runtime.sendMessage({ type: "thundernotes:mail-ack", page, id: intent.id }) as { ok?: boolean } | undefined;
        if (!ack?.ok) break;
      }
    } catch { /* A restarted background is retried on visibility/readiness. */ }
    finally { draining = false; }
  };
  api.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!message || typeof message !== "object") return false;
    const raw = message as { type?: string; locator?: unknown };
    if (raw.type === "thundernotes:mail-wake") { void drain(); return false; }
    if (raw.type === "thundernotes:mail-owner" && isMessageLocator(raw.locator)) {
      try { respond({ exists: primaryOwner(store.getNoteSnapshot(), raw.locator) !== null }); }
      catch { respond({ exists: true }); } // Ambiguous imported metadata must never authorize a duplicate.
    }
    return false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { renderedKey = ""; refreshHeader(); void drain(); }
  });
  // Recover a leased intent after a vanished page; timer is page-lifecycle scoped.
  const retry = setInterval(() => { if (document.visibilityState !== "hidden") void drain(); }, 5000);
  document.defaultView?.addEventListener("pagehide", () => clearInterval(retry), { once: true });
  refreshHeader(); notify(); void drain();
}
