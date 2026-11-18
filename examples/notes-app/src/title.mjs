/**
 * Decide what title to store. Returns the title, or null to reject the note.
 * Baseline behavior: titles are stored exactly as submitted.
 */
export function normalizeTitle(title) {
  if (typeof title !== 'string') return null;
  return title;
}
