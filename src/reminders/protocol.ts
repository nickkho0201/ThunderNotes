export const REMINDER_ALARM_PREFIX = "thundernotes:reminder:";
export const REMINDER_NOTIFICATION_PREFIX = "thundernotes:notification:";
export const REMINDER_OPEN_NOTE_KEY = "thundernotes.reminderOpenNote.v1";

export function reminderAlarmId(noteId: string): string {
  return `${REMINDER_ALARM_PREFIX}${encodeURIComponent(noteId)}`;
}

export function noteIdFromReminderId(value: string, prefix = REMINDER_ALARM_PREFIX): string | null {
  if (!value.startsWith(prefix)) return null;
  try { return decodeURIComponent(value.slice(prefix.length)); } catch { return null; }
}

export type ReminderRuntimeMessage =
  | { type: "thundernotes:reminders-reconcile" }
  | { type: "thundernotes:reminder-fired"; noteId: string; at: number; firedAt: number }
  | { type: "thundernotes:reminder-open-note"; noteId: string };
