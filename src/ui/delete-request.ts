import type { NoteStore } from "./store";
import { t } from "../i18n";

/** One confirmation workflow shared by the button and the list shortcut. */
export function createDeleteRequest(store: NoteStore, confirm: (message: string) => boolean): () => boolean {
  let pending = false;
  return () => {
    const note = store.getSelectedNote();
    if (!note || pending || store.isMutationLocked()) return false;
    const excerpt = note.content.trim().split(/\r?\n/, 1)[0]?.slice(0, 60) ?? "";
    const body = excerpt ? `${t("deleteConfirmMessage")}\n\n${excerpt}` : t("deleteConfirmMessage");
    if (confirm(`${t("deleteConfirmTitle")}\n\n${body}`)) {
      pending = true;
      void store.deleteNote(note.id).catch(() => undefined).finally(() => { pending = false; });
    }
    return true;
  };
}

/** Accept only the list itself or its selected row, never descendant controls. */
export function bindListDelete(list: HTMLElement, store: NoteStore, request: () => boolean): void {
  list.addEventListener("keydown", (event) => {
    if (event.key !== "Delete" || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || list.ownerDocument.activeElement !== target) return;
    if (target !== list && !(target.parentElement === list && target.matches("li.tn-item[role=option]") &&
        target.dataset.id === store.getSelectedId())) return;
    if (target.closest('[contenteditable]:not([contenteditable="false"]), input, textarea, select, button, a, [role=button]')) return;
    if (!store.getVisible().some(({ note }) => note.id === store.getSelectedId())) return;
    if (!request()) return;
    event.preventDefault();
    event.stopPropagation();
  });
}
