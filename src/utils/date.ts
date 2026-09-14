/**
 * Timezone-aware Date & Time formatting utility
 * Ensures local timezone accuracy across server logs, alerts, and API responses.
 */

/**
 * Format a Date object into local time string (e.g. "8:03:11 AM")
 */
export function formatLocalTime(date: Date = new Date()): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/**
 * Format a Date object into local date and time string (e.g. "2026-09-13 08:03:11 AM")
 */
export function formatLocalDateTime(date: Date = new Date()): string {
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/**
 * Returns formatted local timezone string with offset (e.g. "08:03:11 AM (GMT+6)")
 */
export function formatLocalWithTimezone(date: Date = new Date()): string {
  const timeStr = formatLocalTime(date);
  const timeZoneOffset = -date.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(timeZoneOffset) / 60);
  const offsetMinutes = Math.abs(timeZoneOffset) % 60;
  const sign = timeZoneOffset >= 0 ? "+" : "-";
  const offsetFormatted = `GMT${sign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}`;

  return `${timeStr} (${offsetFormatted})`;
}
