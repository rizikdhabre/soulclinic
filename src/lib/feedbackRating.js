export function isValidPainRelief(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}
