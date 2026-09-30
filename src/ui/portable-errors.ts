import { t } from "../i18n";
import { PortableDataError } from "../portable/types";

function parameter(error: PortableDataError, name: string): string {
  const value = error.parameters[name];
  return value === undefined ? "—" : String(value);
}

/** Translate stable Portable Data error codes without exposing technical messages to the UI. */
export function localizePortableError(error: unknown): string {
  if (!(error instanceof PortableDataError)) {
    console.error("[ThunderNotes] unexpected Portable Data failure", error);
    return t("portableErrorUnexpected");
  }

  switch (error.code) {
    case "empty-file":
      return t("portableErrorEmptyFile");
    case "file-read-failed":
      return t("portableErrorFileReadFailed");
    case "file-too-large":
      return t("portableErrorFileTooLarge", [
        parameter(error, "actual"),
        parameter(error, "maximum"),
      ]);
    case "invalid-utf8":
      return t("portableErrorInvalidUtf8");
    case "malformed-json":
      return t("portableErrorMalformedJson");
    case "wrong-format":
      return t("portableErrorWrongFormat");
    case "unsupported-format-version":
      return t("portableErrorUnsupportedFormatVersion", [
        parameter(error, "actual"),
        parameter(error, "supported"),
      ]);
    case "unsupported-note-schema":
      return t("portableErrorUnsupportedNoteSchema", [
        parameter(error, "actual"),
        parameter(error, "supported"),
      ]);
    case "missing-field":
      return t("portableErrorMissingField", parameter(error, "field"));
    case "unknown-field":
      return t("portableErrorUnknownField", parameter(error, "field"));
    case "invalid-shape":
      return t("portableErrorInvalidShape", parameter(error, "path"));
    case "invalid-value":
      return t("portableErrorInvalidValue", parameter(error, "field"));
    case "duplicate-note-id":
      return t("portableErrorDuplicateNoteId");
    case "too-many-notes":
      return t("portableErrorTooManyNotes", [
        parameter(error, "actual"),
        parameter(error, "maximum"),
      ]);
    case "max-depth":
      return t("portableErrorMaxDepth", parameter(error, "maximum"));
    case "invalid-meta":
      return t("portableErrorInvalidMetadata", parameter(error, "path"));
  }
}
