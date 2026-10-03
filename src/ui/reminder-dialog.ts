import { formatDateTime, t } from "../i18n";
import type { Note } from "../notes/model";

export interface ReminderDialogElements {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  trigger: HTMLButtonElement;
  date: HTMLInputElement;
  time: HTMLInputElement;
  set: HTMLButtonElement;
  remove: HTMLButtonElement;
  today: HTMLButtonElement;
  tomorrow: HTMLButtonElement;
  status: HTMLElement;
}

export interface ReminderDialogOptions {
  elements: ReminderDialogElements;
  getNote: () => Note | null;
  /** Async preflight is allowed while opening, never while handling Set. */
  hasPermission: () => Promise<boolean>;
  /** This function is invoked synchronously in the Set click call stack. */
  requestPermission: () => Promise<boolean>;
  saveReminder: (noteId: string, at: number) => Promise<void>;
  removeReminder: (noteId: string) => void | Promise<void>;
  now?: () => number;
  logError?: (message: string, error: unknown) => void;
  onSaved?: (at: number) => void;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

function setInputs(elements: ReminderDialogElements, date: Date): void {
  elements.date.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  elements.time.value = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class ReminderDialogController {
  private submitting = false;
  private permissionGranted: boolean | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ReminderDialogOptions) {
    this.now = options.now ?? (() => Date.now());
    const { elements } = options;
    elements.trigger.addEventListener("click", () => this.open());
    elements.set.addEventListener("click", () => this.submitFromUserGesture());
    elements.form.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.repeat) return;
      const target = event.target;
      // Focused buttons retain their native meaning. In particular, Enter on
      // Remove must remove the reminder rather than being remapped to Set.
      if ((target as HTMLElement | null)?.tagName === "BUTTON" && target !== elements.set) return;
      event.preventDefault();
      this.submitFromUserGesture();
    });
    elements.remove.addEventListener("click", () => this.remove());
    elements.today.addEventListener("click", () => this.setQuick(0));
    elements.tomorrow.addEventListener("click", () => this.setQuick(1));
  }

  open(): void {
    const note = this.options.getNote();
    if (!note) return;
    const reminder = note.reminder?.firedAt === undefined ? note.reminder : null;
    setInputs(this.options.elements, new Date(reminder?.at ?? this.now() + 3_600_000));
    this.options.elements.status.textContent = "";
    this.options.elements.remove.hidden = reminder === null;
    this.options.elements.dialog.showModal();
    this.permissionGranted = null;
    void this.options.hasPermission().then(
      (granted) => { this.permissionGranted = granted; },
      (error) => { this.options.logError?.("notification permission preflight failed", error); },
    );
  }

  /** Deliberately not async: `permissions.request()` must run in this click stack. */
  private submitFromUserGesture(): void {
    if (this.submitting) return;
    const note = this.options.getNote();
    const { elements } = this.options;
    if (!note || !elements.date.value || !elements.time.value) {
      elements.status.textContent = t("reminderFutureRequired");
      return;
    }
    const at = new Date(`${elements.date.value}T${elements.time.value}`).getTime();
    if (!Number.isFinite(at) || at <= this.now()) {
      elements.status.textContent = t("reminderFutureRequired");
      return;
    }

    let permissionResult: Promise<boolean>;
    try {
      // No await or message boundary before this call. If preflight has already
      // confirmed permission, avoid a redundant request entirely.
      permissionResult = this.permissionGranted === true
        ? Promise.resolve(true)
        : this.options.requestPermission();
    } catch (error) {
      this.fail(error);
      return;
    }

    this.submitting = true;
    elements.set.disabled = true;
    elements.status.textContent = "";
    void permissionResult.then(async (granted) => {
      if (!granted) {
        elements.status.textContent = t("reminderPermissionDenied");
        return;
      }
      this.permissionGranted = true;
      await this.options.saveReminder(note.id, at);
      this.options.onSaved?.(at);
      elements.dialog.close();
    }).catch((error) => this.fail(error)).finally(() => {
      this.submitting = false;
      elements.set.disabled = false;
    });
  }

  private fail(error: unknown): void {
    this.options.logError?.("could not set reminder", error);
    const message = error instanceof Error ? error.message : String(error);
    this.options.elements.status.textContent = t("reminderSetError", message);
  }

  private setQuick(days: number): void {
    const now = new Date(this.now());
    const rounded = new Date(now);
    rounded.setSeconds(0, 0);
    rounded.setMinutes(rounded.getMinutes() + (5 - (rounded.getMinutes() % 5)));

    if (days === 0) {
      // Strictly later than "now", including an exact five-minute boundary.
      // Native Date arithmetic carries 23:58 to tomorrow at 00:00.
      setInputs(this.options.elements, rounded);
      return;
    }

    // Tomorrow uses tomorrow's local calendar date with the same rounded clock
    // time as Today. If rounding crossed midnight, that clock time is 00:00.
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(rounded.getHours(), rounded.getMinutes(), 0, 0);
    setInputs(this.options.elements, date);
  }

  private remove(): void {
    const note = this.options.getNote();
    if (note) void this.options.removeReminder(note.id);
    this.options.elements.dialog.close();
  }
}

export function renderReminderTrigger(button: HTMLButtonElement, note: Note | null): void {
  button.disabled = note === null;
  const reminder = note?.reminder?.firedAt === undefined ? note?.reminder : null;
  button.textContent = reminder
    ? `${t("reminderButton")} · ${formatDateTime(reminder.at)}`
    : t("reminderButton");
}

export function reminderSetSuccessNotification(at: number): { title: string; message: string } {
  return { title: t("reminderSetSuccessTitle"), message: formatDateTime(at) };
}
