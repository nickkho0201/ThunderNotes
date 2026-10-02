import { formatDateTime, t } from "../i18n";
import type { MessageReference } from "./locator";

/** One locale-aware presentation for available and unavailable primary links. */
export function formatPrimaryMessage(reference: MessageReference, unavailable = false): { subject: string; metadata: string; title: string } {
  const subject = reference.subject.trim() ? reference.subject : t("messageNoSubject");
  const recipients = reference.recipients?.filter(value => value.trim()).join(", ");
  const details: string[] = [];
  // Participants describe the message without asserting delivery direction.
  // Keep the same readable identity even when kind evidence is unavailable.
  const participants = [reference.author?.trim() ? reference.author : "", recipients].filter(Boolean);
  if (participants.length) details.push(participants.join(" → "));
  if (reference.date !== undefined) {
    const date = formatDateTime(reference.date); if (date) details.push(date);
  }
  const identity = [subject, ...details].join(" · ");
  return { subject, metadata: [unavailable ? t("messageUnavailableLabel") : "", ...details].filter(Boolean).join(" · "),
    title: unavailable ? t("messageUnavailable", identity) : t("messageLinked", identity) };
}
