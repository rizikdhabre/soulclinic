export const MAX_FEEDBACK_WORDS = 50;
export const MAX_FEEDBACK_CHARACTERS = 1000;

export function countFeedbackWords(text) {
  return typeof text === "string" && text.trim() ? text.trim().split(/\s+/u).length : 0;
}

export function isValidFeedbackText(text) {
  if (typeof text !== "string" || text.length > MAX_FEEDBACK_CHARACTERS) return false;
  const words = countFeedbackWords(text);
  return words > 0 && words <= MAX_FEEDBACK_WORDS;
}
