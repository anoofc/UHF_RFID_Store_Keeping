export const DISPLAY_TIME_ZONE = "Asia/Kolkata";

/** SQLite CURRENT_TIMESTAMP is UTC but is returned without a timezone suffix. */
export function parseStoredTimestamp(value: number | string): Date {
  if (typeof value === "number") return new Date(value);
  const sqliteUtc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
  return new Date(sqliteUtc.test(value) ? `${value.replace(" ", "T")}Z` : value);
}

export function formatTime(value: number | string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(parseStoredTimestamp(value));
}

export function formatDateTime(value: number | string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(parseStoredTimestamp(value));
}

export function localDateKey(value: number | string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(parseStoredTimestamp(value));
}
