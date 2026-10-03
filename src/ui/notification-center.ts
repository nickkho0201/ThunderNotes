export type InAppNotificationType = "success" | "info" | "warning" | "error";

export interface InAppNotification {
  type: InAppNotificationType;
  title: string;
  message?: string;
  /** `null` keeps the card visible until it is closed manually. */
  autoDismissMs?: number | null;
}

export interface NotificationCenterOptions {
  closeLabel: string;
}

const DEFAULT_DURATION: Record<InAppNotificationType, number | null> = {
  success: 5_500,
  info: 5_500,
  warning: 10_000,
  error: null,
};

const ICON_TEXT: Record<InAppNotificationType, string> = {
  success: "✓",
  info: "i",
  warning: "!",
  error: "×",
};

/** Generic local notification stack; it has no dependency on reminder state. */
export class InAppNotificationCenter {
  private sequence = 0;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly root: HTMLElement,
    private readonly options: NotificationCenterOptions,
  ) {}

  notify(notification: InAppNotification): string {
    const document = this.root.ownerDocument;
    const id = `tn-notification-${++this.sequence}`;
    const card = document.createElement("article");
    card.id = id;
    card.className = "tn-notification";
    card.dataset.type = notification.type;
    card.setAttribute("aria-atomic", "true");

    const icon = document.createElement("span");
    icon.className = "tn-notification__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = ICON_TEXT[notification.type];

    const content = document.createElement("div");
    content.className = "tn-notification__content";
    const title = document.createElement("strong");
    title.className = "tn-notification__title";
    title.textContent = notification.title;
    content.append(title);
    if (notification.message) {
      const message = document.createElement("p");
      message.className = "tn-notification__message";
      message.textContent = notification.message;
      content.append(message);
    }

    const close = document.createElement("button");
    close.className = "tn-icon-btn tn-notification__close";
    close.type = "button";
    close.title = this.options.closeLabel;
    close.setAttribute("aria-label", this.options.closeLabel);
    const closeIcon = document.createElement("span");
    closeIcon.className = "tn-icon tn-icon--close";
    closeIcon.setAttribute("aria-hidden", "true");
    close.append(closeIcon);
    close.addEventListener("click", () => this.dismiss(id));

    card.append(icon, content, close);
    this.root.append(card);
    this.root.hidden = false;

    const duration = notification.autoDismissMs === undefined
      ? DEFAULT_DURATION[notification.type]
      : notification.autoDismissMs;
    if (duration !== null && duration > 0) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), duration));
    }
    return id;
  }

  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.root.querySelector<HTMLElement>(`#${id}`)?.remove();
    if (this.root.childElementCount === 0) this.root.hidden = true;
  }
}
