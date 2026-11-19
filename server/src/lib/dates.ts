/** The group writes dates with the month in words so nobody confuses day and month: 16/October/2026. */
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** 2026-10-16 (or a longer ISO string) -> 16/October/2026 */
export const dmy = (iso: string) => `${iso.slice(8, 10)}/${MONTHS[Number(iso.slice(5, 7)) - 1]}/${iso.slice(0, 4)}`;
/** 2026-10-01 -> October 2026 */
export const monthName = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
/** Any instant -> 16/October/2026 (Nairobi date) */
export const dmyEAT = (d: Date | string) => dmy(new Date(d).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }));
/** Any instant -> 16/October/2026, 14:30 (Nairobi time, 24-hour) */
export const dmyTimeEAT = (d: Date | string) => `${dmyEAT(d)}, ${new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false })}`;
