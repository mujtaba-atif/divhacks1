/** US national numbers default to +1; international numbers require an explicit +. */
export function normalizeMessagingContact(value: string | undefined): string | undefined {
  const contact = typeof value === "string" ? value.trim() : undefined;
  if (!contact || contact.length > 240) return undefined;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return contact;
  if (!/^\+?[0-9 ().-]+$/.test(contact)) return undefined;
  const digits = contact.replace(/[ ().-]/g, "");
  const international = digits.startsWith("+") ? digits
    : /^\d{10}$/.test(digits) ? `+1${digits}`
    : /^1\d{10}$/.test(digits) ? `+${digits}` : undefined;
  return international && /^\+[1-9]\d{7,14}$/.test(international) ? international : undefined;
}
