/** Short Unicode-safe avatar text from a username.
 * @param value - displayed username.
 * @returns at most two uppercase initials.
 */
export function initials(value: string): string {
  const words = value.trim().split(/\s+/u).filter(Boolean)
  if (words.length > 1) return words.slice(0, 2).map(word => Array.from(word)[0] ?? '').join('').toUpperCase()
  return Array.from(words[0] ?? '?').slice(0, 2).join('').toUpperCase()
}
