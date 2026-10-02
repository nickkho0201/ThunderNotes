import type { MessagesApi, MessageHeader } from "../api/browser";
import { messageReference, type MessageReference } from "../messages/locator";
import { searchMessages } from "../messages/platform";
import { t } from "../i18n";

/** A focused, metadata-only dialog. No global listeners or persisted UI state. */
export class MessagePicker {
  readonly dialog: HTMLDialogElement;
  readonly search: HTMLInputElement;
  readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private results: MessageHeader[] = [];
  private highlighted = 0;
  private controller: AbortController | null = null;
  private finish: ((result: MessageReference | null) => void) | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  constructor(document: Document, private readonly api: MessagesApi) {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "tn-dialog tn-message-picker";
    this.dialog.setAttribute("aria-label", t("messagePickerTitle"));
    const heading = document.createElement("h2"); heading.textContent = t("messagePickerTitle");
    this.search = document.createElement("input"); this.search.type = "search";
    this.search.placeholder = t("messagePickerSearch"); this.search.setAttribute("aria-label", t("messagePickerSearch"));
    this.search.setAttribute("role", "combobox"); this.search.setAttribute("aria-expanded", "true");
    this.search.setAttribute("aria-controls", "tn-message-results"); this.search.setAttribute("aria-autocomplete", "list");
    this.list = document.createElement("div"); this.list.id = "tn-message-results"; this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", t("messagePickerTitle"));
    this.status = document.createElement("p"); this.status.setAttribute("role", "status");
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "tn-btn"; cancel.textContent = t("cancel");
    const draftHint = document.createElement("p"); draftHint.className = "tn-message-hint"; draftHint.textContent = t("messageDraftHint");
    cancel.addEventListener("click", () => this.close(null));
    this.dialog.append(heading, this.search, this.list, this.status, draftHint, cancel); document.body.append(this.dialog);
    this.search.addEventListener("input", () => {
      this.sequence++; this.controller?.abort(); this.results = []; this.list.replaceChildren();
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => { this.debounce = null; void this.load(); }, 200);
    });
    this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(null); });
    this.dialog.addEventListener("keydown", event => {
      // Own keyboard handling only inside this modal; keep its shortcuts local.
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); this.close(null); }
      else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && this.results.length) {
        event.preventDefault(); this.highlighted = (this.highlighted + (event.key === "ArrowDown" ? 1 : -1) + this.results.length) % this.results.length;
        this.render();
      } else if (event.key === "Enter" && document.activeElement === this.search && this.results.length) {
        event.preventDefault(); this.choose(this.highlighted);
      }
    });
    this.dialog.addEventListener("close", () => { if (this.finish) this.close(null); });
  }
  open(): Promise<MessageReference | null> {
    if (this.finish) this.close(null);
    this.search.value = ""; this.results = []; this.highlighted = 0;
    this.list.replaceChildren();
    this.dialog.showModal(); this.search.focus();
    return new Promise(resolve => { this.finish = resolve; void this.load(); });
  }
  private close(result: MessageReference | null): void {
    this.sequence++; this.controller?.abort();
    if (this.debounce) clearTimeout(this.debounce); this.debounce = null;
    const finish = this.finish; this.finish = null;
    if (this.dialog.open) this.dialog.close(); finish?.(result);
  }
  private choose(index: number): void {
    const message = this.results[index]; if (message) this.close(messageReference(message));
  }
  private async load(): Promise<void> {
    this.controller?.abort(); this.controller = new AbortController();
    const sequence = ++this.sequence;
    this.status.textContent = t("messageLoading");
    try {
      const result = await searchMessages(this.api, this.search.value, this.controller.signal);
      if (sequence !== this.sequence || !this.finish) return;
      this.results = result.messages; this.highlighted = 0; this.render();
      this.status.textContent = result.limited ? t("messageSearchLimited") : this.results.length ? "" : t("messageNoResults");
    } catch {
      if (sequence === this.sequence && this.finish) this.status.textContent = t("messageSearchError");
    }
  }
  private render(): void {
    this.list.replaceChildren(); this.search.removeAttribute("aria-activedescendant");
    this.results.forEach((message, index) => {
      const button = this.dialog.ownerDocument.createElement("button");
      button.type = "button"; button.className = "tn-message-result"; button.id = `tn-message-result-${index}`;
      button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(index === this.highlighted));
      button.tabIndex = -1;
      const title = this.dialog.ownerDocument.createElement("strong"); title.textContent = message.subject || t("messageNoSubject");
      const context = this.dialog.ownerDocument.createElement("span");
      const locale = this.dialog.ownerDocument.documentElement.lang || undefined;
      context.textContent = `${message.author} · ${(message.recipients ?? []).join(", ")} · ${new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(message.date)}`;
      button.title = `${title.textContent}\n${context.textContent}`; button.append(title, context);
      button.addEventListener("click", () => this.choose(index)); this.list.append(button);
      if (index === this.highlighted) this.search.setAttribute("aria-activedescendant", button.id);
    });
    this.list.children[this.highlighted]?.scrollIntoView?.({ block: "nearest" });
  }
}
