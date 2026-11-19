/**
 * Normalises Kenyan mobile numbers to the 2547XXXXXXXX / 2541XXXXXXXX format Daraja expects.
 * Returns null if the value is not a valid Kenyan mobile number.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s\-()+]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  let n = digits;
  if (n.startsWith('254')) n = n.slice(3);
  else if (n.startsWith('0')) n = n.slice(1);
  if (!/^[17]\d{8}$/.test(n)) return null;
  return `254${n}`;
}
