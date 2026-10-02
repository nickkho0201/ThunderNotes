import type { MessagesApi, MessageHeader } from "../api/browser";
import { messageReference, type MessageReference } from "../messages/locator";
import { formatPrimaryMessage } from "../messages/presentation";
import { searchMessages } from "../messages/platform";
import { readMessageExcerpt } from "../messages/excerpt";
import { messageRecipients } from "../messages/search";
import { t } from "../i18n";

export const MESSAGE_HOVER_DELAY = 350;
const PREVIEW_CACHE_LIMIT = 20;
/** Modal-local search; ephemeral body excerpts require deliberate mouse hover. */
export class MessagePicker {
  readonly dialog: HTMLDialogElement;
  readonly search: HTMLInputElement;
  readonly list: HTMLElement;
  readonly preview: HTMLElement;
  private readonly previewSubject: HTMLElement;
  private readonly previewIdentity: HTMLElement;
  private readonly previewBody: HTMLElement;
  private readonly status: HTMLElement;
  private results: MessageHeader[] = [];
  private highlighted = 0;
  private controller: AbortController | null = null;
  private finish: ((result: MessageReference | null) => void) | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private previewSequence = 0;
  private opener: HTMLElement | null = null;
  private readonly cache = new Map<string, Promise<string>>();
  constructor(document: Document, private readonly api: MessagesApi) {
    this.dialog = document.createElement("dialog"); this.dialog.className = "tn-dialog tn-message-picker";
    const header = document.createElement("div"); header.className = "tn-dialog__header";
    const heading = document.createElement("h2"); heading.id = "tn-message-picker-title"; heading.textContent = t("messagePickerTitle");
    this.dialog.setAttribute("aria-labelledby", heading.id);
    const close = document.createElement("button"); close.type = "button"; close.className = "tn-icon-btn tn-dialog__close";
    close.title = t("cancel"); close.setAttribute("aria-label", t("cancel"));
    const closeIcon = document.createElement("span"); closeIcon.className = "tn-icon tn-icon--close"; closeIcon.setAttribute("aria-hidden", "true"); close.append(closeIcon);
    close.addEventListener("click", () => this.close(null)); header.append(heading, close);
    const body = document.createElement("div"); body.className = "tn-message-picker__body";
    const searchArea = document.createElement("div"); searchArea.className = "tn-message-picker__search";
    const searchIcon = document.createElement("span"); searchIcon.className = "tn-icon tn-icon--search"; searchIcon.setAttribute("aria-hidden", "true");
    this.search = document.createElement("input"); this.search.type = "search";
    this.search.placeholder = t("messagePickerSearch"); this.search.setAttribute("aria-label", t("messagePickerSearch"));
    this.search.setAttribute("role", "combobox"); this.search.setAttribute("aria-expanded", "false");
    this.search.setAttribute("aria-controls", "tn-message-results"); this.search.setAttribute("aria-autocomplete", "list");
    searchArea.append(searchIcon, this.search);
    this.list = document.createElement("div"); this.list.id = "tn-message-results"; this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", t("messagePickerTitle")); this.list.addEventListener("scroll", () => this.clearPreview());
    this.status = document.createElement("p"); this.status.className = "tn-message-picker__status"; this.status.setAttribute("role", "status");
    const draftHint = document.createElement("p"); draftHint.className = "tn-message-hint"; draftHint.textContent = t("messageDraftHint");
    body.append(searchArea, this.list, this.status, draftHint);
    const footer = document.createElement("div"); footer.className = "tn-dialog__footer";
    const hint = document.createElement("span"); hint.className = "tn-message-hint"; hint.textContent = t("messagePickerHint");
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "tn-btn"; cancel.textContent = t("cancel");
    cancel.addEventListener("click", () => this.close(null)); footer.append(hint, cancel);
    this.preview = document.createElement("aside"); this.preview.className = "tn-message-hover-preview"; this.preview.hidden = true;
    this.preview.setAttribute("aria-hidden", "true");
    this.previewSubject = document.createElement("strong"); this.previewIdentity = document.createElement("p"); this.previewIdentity.className = "tn-message-hint";
    this.previewBody = document.createElement("p"); this.previewBody.className = "tn-message-hover-preview__text";
    this.preview.append(this.previewSubject, this.previewIdentity, this.previewBody);
    this.dialog.append(header, body, footer, this.preview); document.body.append(this.dialog);
    this.search.addEventListener("input", () => {
      this.sequence++; this.controller?.abort(); this.clearPreview(); this.results = []; this.list.replaceChildren(); this.highlighted = 0;
      this.search.removeAttribute("aria-activedescendant"); this.list.setAttribute("aria-busy", "true"); this.status.textContent = t("messageLoading");
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => { this.debounce = null; if (this.finish) void this.load(); }, 200);
    });
    this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(null); });
    this.dialog.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); this.close(null); }
      else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && document.activeElement === this.search && this.results.length) {
        event.preventDefault(); this.clearPreview();
        this.highlighted = (this.highlighted + (event.key === "ArrowDown" ? 1 : -1) + this.results.length) % this.results.length; this.highlight();
      } else if (event.key === "Enter" && document.activeElement === this.search && this.results.length) {
        event.preventDefault(); this.choose(this.highlighted);
      }
    });
    this.dialog.addEventListener("close", () => { if (this.finish) this.close(null); });
    document.defaultView?.addEventListener("resize", () => this.clearPreview());
  }
  open(): Promise<MessageReference | null> {
    if (this.finish) this.close(null);
    this.opener = this.dialog.ownerDocument.activeElement as HTMLElement | null;
    this.search.value = ""; this.results = []; this.highlighted = 0; this.list.replaceChildren();
    this.search.removeAttribute("aria-activedescendant"); this.search.setAttribute("aria-expanded", "true");
    this.dialog.showModal(); this.search.focus();
    return new Promise(resolve => { this.finish = resolve; void this.load(); });
  }
  private clearPreview(): void {
    this.previewSequence++; if (this.hoverTimer) clearTimeout(this.hoverTimer); this.hoverTimer = null;
    this.preview.hidden = true; this.previewBody.textContent = "";
  }
  private close(result: MessageReference | null): void {
    this.sequence++; this.controller?.abort(); this.clearPreview(); this.cache.clear();
    if (this.debounce) clearTimeout(this.debounce); this.debounce = null;
    const finish = this.finish; this.finish = null; this.search.setAttribute("aria-expanded", "false");
    if (this.dialog.open) this.dialog.close();
    if (this.opener?.isConnected) this.opener.focus(); this.opener = null; finish?.(result);
  }
  private choose(index: number): void {
    const message = this.results[index]; if (message) this.close(messageReference(message));
  }
  private async load(): Promise<void> {
    this.controller?.abort(); this.controller = new AbortController(); const sequence = ++this.sequence;
    this.list.setAttribute("aria-busy", "true"); this.status.textContent = t("messageLoading");
    try {
      const result = await searchMessages(this.api, this.search.value, this.controller.signal);
      if (sequence !== this.sequence || !this.finish) return;
      this.results = result.messages; this.highlighted = 0; this.render();
      this.status.textContent = result.limited ? t("messageSearchLimited") : this.results.length ? "" : t("messageNoResults");
    } catch {
      if (sequence === this.sequence && this.finish) this.status.textContent = t("messageSearchError");
    } finally { if (sequence === this.sequence) this.list.setAttribute("aria-busy", "false"); }
  }
  private identity(message: MessageHeader) {
    return formatPrimaryMessage({ ...messageReference(message)!, author: message.author, recipients: messageRecipients(message), date: message.date.getTime() });
  }
  private hover(message: MessageHeader): void {
    this.clearPreview();
    const view = this.dialog.ownerDocument.defaultView;
    if (view && (view.innerWidth < 680 || view.innerHeight < 430)) return;
    const sequence = this.previewSequence;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null; if (this.finish && sequence === this.previewSequence) void this.showPreview(message, sequence);
    }, MESSAGE_HOVER_DELAY);
  }
  private async showPreview(message: MessageHeader, sequence: number): Promise<void> {
    const identity = this.identity(message), rect = this.dialog.getBoundingClientRect();
    const width = this.dialog.ownerDocument.defaultView?.innerWidth ?? 800;
    this.preview.classList.toggle("is-side", rect.right + 322 <= width);
    this.previewSubject.textContent = identity.subject; this.previewIdentity.textContent = identity.metadata;
    this.previewBody.textContent = t("messagePreviewLoading"); this.preview.hidden = false;
    const key = JSON.stringify([message.id, message.headerMessageId, message.date.getTime()]);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = readMessageExcerpt(this.api, message.id); this.cache.set(key, pending);
      if (this.cache.size > PREVIEW_CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    } else { this.cache.delete(key); this.cache.set(key, pending); }
    try {
      const excerpt = await pending;
      if (sequence === this.previewSequence && this.finish) this.previewBody.textContent = excerpt;
    } catch {
      if (this.cache.get(key) === pending) this.cache.delete(key);
      if (sequence === this.previewSequence && this.finish) this.previewBody.textContent = t("messagePreviewUnavailable");
    }
  }
  private highlight(): void {
    this.search.removeAttribute("aria-activedescendant");
    [...this.list.children].forEach((button, index) => {
      button.setAttribute("aria-selected", String(index === this.highlighted));
      if (index === this.highlighted) this.search.setAttribute("aria-activedescendant", button.id);
    });
    this.list.children[this.highlighted]?.scrollIntoView?.({ block: "nearest" });
  }
  private render(): void {
    this.clearPreview(); this.list.replaceChildren();
    this.results.forEach((message, index) => {
      const button = this.dialog.ownerDocument.createElement("button"); button.type = "button";
      button.className = "tn-message-result"; button.id = `tn-message-result-${index}`; button.setAttribute("role", "option"); button.tabIndex = -1;
      const identity = this.identity(message);
      const title = this.dialog.ownerDocument.createElement("strong"); title.textContent = identity.subject;
      const context = this.dialog.ownerDocument.createElement("span"); context.textContent = identity.metadata;
      button.title = identity.title; button.setAttribute("aria-label", identity.title); button.append(title, context);
      button.addEventListener("click", () => this.choose(index));
      button.addEventListener("mouseenter", () => this.hover(message)); button.addEventListener("mouseleave", () => this.clearPreview());
      this.list.append(button);
    });
    this.highlight();
  }
}
