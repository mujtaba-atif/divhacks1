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

/** Public contact label; full destinations remain server-managed. */
export function maskMessagingContact(value: string | undefined): string {
  const contact = normalizeMessagingContact(value);
  if (!contact) return "Contact not configured";
  if (contact.includes("@")) return `${contact[0]}***@${contact.split("@")[1]}`;
  return `${contact.startsWith("+1") && contact.length === 12 ? "+1" : "+"} (***) ***-${contact.slice(-4)}`;
}
