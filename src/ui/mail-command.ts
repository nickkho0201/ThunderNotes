import { inlineMessageLink, type MessageReference } from "../messages/locator";
import type { TextEdit } from "./markdown-edit";
import { t } from "../i18n";

export interface MailToken { start: number; end: number; matches: boolean }
export function mailToken(value: string, start: number, end: number): MailToken | null {
  if (start !== end) return null;
  const match = /(?:^|\s)(\/[a-z]*)$/i.exec(value.slice(0, start));
  if (!match) return null;
  const token = match[1]!;
  return { start: start - token.length, end: start, matches: "/mail".startsWith(token.toLowerCase()) };
}
export function bindMailCommand(options: {
  textarea: HTMLTextAreaElement; enabled: () => boolean;
  pick: () => Promise<MessageReference | null>;
  mutate: (edit: TextEdit) => void;
  noteId: () => string | null;
}): { reset(): void; menu: HTMLElement } {
  const { textarea } = options, document = textarea.ownerDocument;
  const menu = document.createElement("div"); menu.className = "tn-mail-command"; menu.id = "tn-mail-command";
  menu.setAttribute("role", "listbox"); menu.setAttribute("aria-label", t("messageCommandDescription")); menu.hidden = true;
  const command = document.createElement("button"); command.type = "button"; command.id = "tn-mail-command-option";
  command.setAttribute("role", "option"); command.setAttribute("aria-selected", "true");
  command.textContent = `/mail — ${t("messageCommandDescription")}`; menu.append(command); document.body.append(menu);
  let composing = false, dismissed: string | null = null, picking = false;
  const hide = (): void => {
    menu.hidden = true; textarea.removeAttribute("aria-controls"); textarea.removeAttribute("aria-activedescendant");
  };
  const update = (): void => {
    const token = mailToken(textarea.value, textarea.selectionStart, textarea.selectionEnd);
    if (!options.enabled() || textarea.hidden || document.activeElement !== textarea || composing || picking || !token?.matches ||
      dismissed === `${token.start}:${textarea.value.slice(token.start, token.end)}`) { hide(); return; }
    const rect = textarea.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left + 12, (document.defaultView?.innerWidth ?? 800) - 300))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.top + 36, (document.defaultView?.innerHeight ?? 600) - 56))}px`;
    menu.hidden = false; textarea.setAttribute("aria-controls", menu.id); textarea.setAttribute("aria-activedescendant", command.id);
  };
  const execute = async (): Promise<void> => {
    const token = mailToken(textarea.value, textarea.selectionStart, textarea.selectionEnd);
    if (!token?.matches || !options.enabled() || picking) return;
    const noteId = options.noteId(), source = textarea.value, direction = textarea.selectionDirection;
    const start = textarea.selectionStart, end = textarea.selectionEnd, scrollTop = textarea.scrollTop;
    picking = true; hide();
    let reference: MessageReference | null = null;
    try { reference = await options.pick(); } catch { /* A failed picker keeps the command token. */ } finally {
      picking = false;
      // A changed note/import/source must never receive an edit at stale offsets.
      if (options.noteId() === noteId && textarea.value === source && options.enabled() && !textarea.hidden) {
        textarea.focus(); textarea.setSelectionRange(start, end, direction); textarea.scrollTop = scrollTop;
        if (reference) {
          const text = inlineMessageLink({ ...reference, subject: reference.subject || t("messageNoSubject") });
          options.mutate({ start: token.start, end: token.end, text, selectionStart: token.start + text.length, selectionEnd: token.start + text.length });
        } else dismissed = `${token.start}:${source.slice(token.start, token.end)}`;
      }
    }
  };
  command.addEventListener("mousedown", event => event.preventDefault());
  command.addEventListener("click", () => { void execute(); });
  textarea.addEventListener("compositionstart", () => { composing = true; hide(); });
  textarea.addEventListener("compositionend", () => { composing = false; update(); });
  textarea.addEventListener("input", update); textarea.addEventListener("click", update);
  textarea.addEventListener("keyup", update); textarea.addEventListener("blur", hide);
  textarea.addEventListener("keydown", event => {
    if (!options.enabled() || document.activeElement !== textarea || textarea.hidden || textarea.disabled || textarea.readOnly ||
      composing || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || menu.hidden) return;
    if (!["Enter", "Escape", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Escape") {
      const token = mailToken(textarea.value, textarea.selectionStart, textarea.selectionEnd);
      if (token) dismissed = `${token.start}:${textarea.value.slice(token.start, token.end)}`; hide();
    } else if (event.key === "Enter") { void execute(); }
  }, true);
  return { menu, reset() { dismissed = null; hide(); } };
}
