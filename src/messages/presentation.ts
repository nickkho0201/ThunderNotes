import { formatDateTime, t } from "../i18n";
import type { MessageReference } from "./locator";

/** One locale-aware presentation for available and unavailable primary links. */
export function formatPrimaryMessage(reference: MessageReference, unavailable = false): { kind: string; badge: string; text: string; title: string } {
  const kind = t(`messageKind_${reference.kind ?? "unknown"}`);
  const recipients = reference.recipients?.filter(value => value.trim()).join(", ");
  const details: string[] = [];
  if (reference.kind === "incoming") {
    if (reference.author?.trim()) details.push(reference.author);
  } else if (reference.kind === "outgoing" || reference.kind === "draft") {
    if (recipients) details.push(recipients);
  } else {
    if (reference.author?.trim()) details.push(t("messageFrom", reference.author));
    if (recipients) details.push(t("messageTo", recipients));
  }
  details.push(reference.subject.trim() ? reference.subject : t("messageNoSubject"));
  if (reference.date !== undefined) {
    const date = formatDateTime(reference.date); if (date) details.push(date);
  }
  const identity = `${kind} · ${details.join(" · ")}`;
  return { kind, badge: t(`messageKindShort_${reference.kind ?? "unknown"}`), text: unavailable ? t("messageUnavailable", details.join(" · ")) : details.join(" · "),
    title: unavailable ? t("messageUnavailable", identity) : t("messageLinked", identity) };
}
