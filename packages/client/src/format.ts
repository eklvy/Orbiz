const rupees = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const rupeesWithPaise = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
});

/** Formats integer paise as rupees: 7000 → "₹70", 7050 → "₹70.50". */
export function formatPaise(paise: number): string {
  return paise % 100 === 0 ? rupees.format(paise / 100) : rupeesWithPaise.format(paise / 100);
}

/**
 * Parses a rupee amount typed by a manager ("70", "70.5", "₹1,250.75") into integer paise
 * without floating-point arithmetic. Returns null for anything else.
 */
export function parseRupeesToPaise(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, "");
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match?.[1]) return null;
  const paise = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return paise > 0 ? paise : null;
}

/** Integer paise as a plain rupee string for an input field: 7050 → "70.50", 7000 → "70". */
export function paiseToRupeeInput(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return rest === 0 ? String(rupees) : `${rupees}.${String(rest).padStart(2, "0")}`;
}

/** Wall-clock time in the outlet's time zone, e.g. "1:15 pm". */
export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
}

function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date); // YYYY-MM-DD
}

/** "Today", "Tomorrow" or e.g. "Thu, 16 Oct", in the outlet's time zone. */
export function formatDayLabel(iso: string, timeZone: string, now: Date = new Date()): string {
  const target = localDate(new Date(iso), timeZone);
  if (target === localDate(now, timeZone)) return "Today";
  if (target === localDate(new Date(now.getTime() + 86_400_000), timeZone)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

/** e.g. "1:15 pm – 1:30 pm". */
export function formatSlot(startsAt: string, endsAt: string, timeZone: string): string {
  return `${formatTime(startsAt, timeZone)} – ${formatTime(endsAt, timeZone)}`;
}

/** Remaining time as m:ss (never negative). */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Time left for staff screens: m:ss under an hour, otherwise e.g. "7 h 35 min". */
export function formatTimeLeft(msRemaining: number): string {
  if (msRemaining < 3_600_000) return formatCountdown(msRemaining);
  const minutes = Math.floor(msRemaining / 60_000);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export const CAMPUS_TIME_ZONE = "Asia/Kolkata";
