/**
 * SPEC §11.1, normalization N: nine steps, in the order the SPEC fixes. Applied to the model
 * output and to every entity name before it is matched.
 */
export function normalize(text: string): string {
  let t = text.normalize('NFC') // 1
  t = t.replace(/\r\n|\r/g, '\n') // 2
  t = t.replace(/[*_]/g, '') // 3
  t = t.replace(/[    ⁠]/g, ' ') // 4
  t = t.replace(/[^\S\n]+/g, ' ') // 5
  t = t
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // 6
  t = t.trim() // 7
  t = t.replace(/\bCOP (?=\d)/g, 'COP') // 8
  t = t.replace(/ %/g, '%') // 9
  return t
}

/**
 * SPEC §11.10 step 2, folding: NFD, every combining mark deleted, then `toLowerCase()`. The
 * marker list is written already folded, and the masked text is folded the same way before it
 * is compared. Nothing else is folded: dates and headers are compared as written (§3.4).
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}
