export function normalizeIsraeliPhone(input) {
  if (!input) return null;

  let phone = input.toString().trim();

  phone = phone.replace(/[^\d+]/g, "");

  if (phone.startsWith("00")) {
    phone = "+" + phone.slice(2);
  }

  if (phone.startsWith("+")) {
    phone = phone.slice(1);
  }

  if (phone.startsWith("05")) {
    phone = "972" + phone.slice(1);
  }

  if (!phone.startsWith("972")) return null;

  const normalized = `+${phone}`;

  const israeliMobileRegex = /^\+9725\d{8}$/;

  return israeliMobileRegex.test(normalized) ? normalized : null;
}

export function getWhatsAppLink(input) {
  const normalized = normalizeIsraeliPhone(input);

  if (!normalized) return "https://wa.me/";

  return `https://wa.me/${normalized.slice(1)}`;
}
