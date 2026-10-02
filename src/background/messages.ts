import type { ThunderbirdBrowser, MessageTab } from "../api/browser";
import { IndexedDbNotesRepository } from "../storage/indexeddb";
import type { NotesRepository } from "../storage/repository";
import { ensureSpaceRegistered } from "./space";
import { MessageNavigation } from "../messages/navigation";
import { messageReference, primaryOwner, type MessageReference } from "../messages/locator";
import { t } from "../i18n";

/** Labels derive from note data. Only the page/store writes notes. */
export function startMessageActions(api: ThunderbirdBrowser, repository: NotesRepository = new IndexedDbNotesRepository()): void {
  const navigation = new MessageNavigation(api.storage?.local);
  let targetWindow: number | undefined;
  const versions = new Map<number, number>();
  const owner = async (reference: MessageReference): Promise<boolean> => {
    try {
      return primaryOwner(await repository.getAll(), reference.locator) !== null;
    } catch { /* Memory fallback is page-owned when IndexedDB is unavailable. */ }
    try {
      const live = await api.runtime.sendMessage({ type: "thundernotes:mail-owner", locator: reference.locator });
      if (typeof (live as { exists?: unknown } | null)?.exists === "boolean") return (live as { exists: boolean }).exists;
    } catch { /* No live page: read through repository. */ }
    throw new Error("Authoritative note state unavailable");
  };
  const refresh = async (tab: MessageTab): Promise<void> => {
    if (tab.id === undefined || !api.messageDisplay || !api.messageDisplayAction) return;
    const tabId = tab.id, version = (versions.get(tabId) ?? 0) + 1; versions.set(tabId, version);
    try {
      const page = await api.messageDisplay.getDisplayedMessages(tabId);
      const reference = page.messages.length === 1 ? messageReference(page.messages[0]!) : null;
      const exists = reference ? await owner(reference) : false;
      if (versions.get(tabId) !== version) return;
      await api.messageDisplayAction.setTitle({ tabId, title: t(reference ? exists ? "messageOpenNote" : "messageNewNote" : "messageNoStableId") });
      if (reference) await api.messageDisplayAction.enable(tabId); else await api.messageDisplayAction.disable(tabId);
    } catch { if (versions.get(tabId) === version) await api.messageDisplayAction.disable(tabId).catch(() => {}); }
  };
  const refreshAll = async (): Promise<void> => { for (const tab of await api.tabs?.query({}) ?? []) await refresh(tab); };
  api.messageDisplay?.onMessagesDisplayed.addListener(tab => { void refresh(tab); });
  const clicks = new Map<string, Promise<void>>();
  api.messageDisplayAction?.onClicked.addListener(tab => {
    void (async () => {
      const page = await api.messageDisplay?.getDisplayedMessages(tab.id);
      const reference = page?.messages.length === 1 ? messageReference(page.messages[0]!) : null;
      if (!reference) return;
      const key = reference.locator.headerMessageId;
      if (clicks.has(key)) return clicks.get(key);
      const work = (async () => {
        const result = await ensureSpaceRegistered();
        if (!result.ok || !result.space || !api.spaces) throw new Error("Notes Space unavailable");
        // Reuse the existing Space across message windows, without tabs permission.
        const existing = await api.tabs?.query({ spaceId: result.space.id });
        targetWindow = existing?.find(entry => entry.windowId !== undefined)?.windowId;
        await navigation.enqueue(reference);
        const opened = await api.spaces.open(result.space.id, targetWindow) as MessageTab | undefined;
        targetWindow ??= opened?.windowId;
        if (targetWindow !== undefined) await api.windows?.update(targetWindow, { focused: true });
        await api.runtime.sendMessage({ type: "thundernotes:mail-wake" }).catch(() => {});
      })();
      clicks.set(key, work); try { await work; } finally { clicks.delete(key); }
    })().catch(error => console.error("[ThunderNotes] message navigation failed", error));
  });
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || typeof message !== "object") return false;
    const raw = message as { type?: string; page?: string; id?: string; windowId?: number };
    if (!raw.type?.startsWith("thundernotes:mail-")) return false;
    const source = sender as { url?: string } | null;
    if (source?.url?.split(/[?#]/)[0] !== api.runtime.getURL("notes.html")) return false;
    let work: Promise<unknown> | null = null;
    if (raw.type === "thundernotes:mail-next" && typeof raw.page === "string") {
      work = (async () => {
        // A closed target window must not strand a persisted intent.
        if (targetWindow !== undefined && raw.windowId !== targetWindow) {
          const tabs = await api.tabs?.query({ windowId: targetWindow });
          if (tabs?.length) return null;
          targetWindow = undefined;
        }
        const intent = await navigation.next(raw.page!);
        if (intent && targetWindow === undefined && Number.isInteger(raw.windowId) && raw.windowId! >= 0) {
          const result = await ensureSpaceRegistered();
          if (!result.ok || !result.space || !api.spaces) throw new Error("Notes Space unavailable");
          targetWindow = raw.windowId;
          await api.spaces.open(result.space.id, targetWindow);
          await api.windows?.update(targetWindow!, { focused: true });
        }
        return intent;
      })();
    }
    if (raw.type === "thundernotes:mail-ack" && typeof raw.page === "string" && typeof raw.id === "string") work = navigation.ack(raw.page, raw.id);
    if (raw.type === "thundernotes:mail-changed") work = refreshAll();
    if (!work) return false;
    void work.then(value => respond({ ok: true, value }), () => respond({ ok: false })); return true;
  });
  void refreshAll().catch(() => {});
}
