import type { Alarm, ThunderbirdBrowser } from "../api/browser";
import { t } from "../i18n";
import { buildNotePreview } from "../notes/preview";
import { applyNoteChange } from "../notes/model";
import type { NotesRepository } from "../storage/repository";
import {
  REMINDER_NOTIFICATION_PREFIX, noteIdFromReminderId, reminderAlarmId,
} from "./protocol";

export class ReminderService {
  private readonly firing = new Set<string>();

  constructor(
    private readonly api: ThunderbirdBrowser,
    private readonly repository: NotesRepository,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async reconcile(): Promise<void> {
    const alarms = this.api.alarms;
    if (!alarms) return;
    const notes = await this.repository.getAll();
    const pending = new Map(notes.filter((n) => n.reminder && !n.reminder.firedAt).map((n) => [n.id, n]));
    for (const alarm of await alarms.getAll()) {
      const id = noteIdFromReminderId(alarm.name);
      if (id !== null && !pending.has(id)) await alarms.clear(alarm.name);
    }
    for (const note of pending.values()) {
      if (note.reminder!.at <= this.now()) await this.fire(note.id, note.reminder!.at);
      else {
        const name = reminderAlarmId(note.id);
        const current = await alarms.get(name);
        if (!current || current.scheduledTime !== note.reminder!.at) {
          await Promise.resolve(alarms.create(name, { when: note.reminder!.at }));
        }
      }
    }
  }

  async handleAlarm(alarm: Alarm): Promise<void> {
    const noteId = noteIdFromReminderId(alarm.name);
    if (noteId !== null) await this.fire(noteId, alarm.scheduledTime);
  }

  private async fire(noteId: string, expectedAt: number): Promise<void> {
    if (this.firing.has(noteId)) return;
    this.firing.add(noteId);
    try {
      const note = await this.repository.get(noteId);
      if (!note?.reminder || note.reminder.firedAt || note.reminder.at !== expectedAt) return;
      const firedAt = this.now();
      const updated = applyNoteChange(note, { reminder: null }, firedAt);

      // Persist completion before delivering: after a worker/browser restart the
      // one-shot reminder is no longer pending and can never be delivered twice.
      await this.repository.update(updated);

      let alarmCleanupError: unknown;
      try {
        await this.api.alarms?.clear(reminderAlarmId(noteId));
      } catch (error) {
        alarmCleanupError = error;
      }

      try {
        if (this.api.notifications && await this.api.permissions?.contains({ permissions: ["notifications"] })) {
          const preview = buildNotePreview(note);
          await this.api.notifications.create(`${REMINDER_NOTIFICATION_PREFIX}${encodeURIComponent(noteId)}`, {
            type: "basic", title: t("extName"), message: preview.title || t("newNote"),
            iconUrl: this.api.runtime.getURL("assets/icons/notes-solid-64.svg"), isClickable: true,
          });
        }
      } finally {
        void this.api.runtime.sendMessage({
          type: "thundernotes:reminder-fired", noteId, at: expectedAt, firedAt,
        }).catch(() => undefined);
      }

      // Notification delivery remains useful even if explicit cleanup failed.
      // Persisted `null` still prevents duplicate delivery; surface the cleanup
      // failure to the background listener so it is diagnosable.
      if (alarmCleanupError !== undefined) throw alarmCleanupError;
    } finally {
      this.firing.delete(noteId);
    }
  }
}
