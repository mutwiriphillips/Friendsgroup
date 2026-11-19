export const kes = (cents: number | string | null | undefined) =>
  `KSh ${(Number(cents ?? 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const NAIROBI = { timeZone: 'Africa/Nairobi' } as const;
/** All dates are shown as dd/mm/yyyy. */
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Dates are written with the month in words so nobody confuses day and month: 16/October/2026. */
export const dmy = (iso: string) => `${iso.slice(8, 10)}/${MONTHS[Number(iso.slice(5, 7)) - 1]}/${iso.slice(0, 4)}`;
const eatDate = (d: string) => new Date(d).toLocaleDateString('en-CA', NAIROBI);
export const dateFmt = (d: string | null | undefined) => (d ? dmy(d.length === 10 ? d : eatDate(d)) : '—');
export const dateTimeFmt = (d: string | null | undefined) => (d ? `${dmy(eatDate(d))}, ${new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...NAIROBI })}` : '—');
export const monthFmt = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
export const human = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
