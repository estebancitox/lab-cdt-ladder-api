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
  t = t.replace(/\$ (?=\d)/g, '$') // 8
  t = t.replace(/ %/g, '%') // 9
  return t
}

/**
 * Lowercased and accent-folded, the form SPEC §11.3 defines the date vocabulary D in and
 * §11.10 compares its closed list in. Combining marks are dropped after NFD, so `ñ` folds to
 * `n` as well; the text and the vocabulary are folded the same way, which is all that matters.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}
