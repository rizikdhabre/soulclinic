export function normalizeIsraeliPhone(input) {
  if (!input) return null;
  let phone = input.replace(/\D/g, "");


  if (phone.startsWith("0")) {
    phone = "972" + phone.slice(1);
  }

  if (phone.startsWith("972")) {

  } else {
    return null;
  }

  const normalized = `+${phone}`;

  const israeliMobileRegex = /^\+9725\d{8}$/;

  if (!israeliMobileRegex.test(normalized)) {
    return null;
  }

  return normalized;
}
