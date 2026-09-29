import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { specEnginePin } from './test-support/contract'

const ENGINE_DIR = new URL('./engine/', import.meta.url)
const RECORD = readFileSync(new URL('VENDOR.md', ENGINE_DIR), 'utf8')

function recordedHashes(): Map<string, string> {
  const rows = new Map<string, string>()
  for (const m of RECORD.matchAll(/^\| ([^ |]+) \| ([0-9a-f]{64}) \|$/gm)) rows.set(m[1], m[2])
  return rows
}

function sha256(file: string): string {
  return createHash('sha256')
    .update(readFileSync(new URL(file, ENGINE_DIR)))
    .digest('hex')
}

describe('src/engine is the pinned upstream copy (SPEC §9)', () => {
  const files = readdirSync(ENGINE_DIR).sort()
  const production = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  const tests = files.filter((f) => f.endsWith('.test.ts'))

  it('VENDOR.md names the upstream, a vendoring date, and the commit SPEC.md pins', () => {
    expect(RECORD).toMatch(/^Upstream: https:\/\/github\.com\/estebancitox\/lab-cdt-ladder$/m)
    expect(RECORD).toMatch(/^Vendored: \d{4}-\d{2}-\d{2}$/m)
    const commit = /^Commit: ([0-9a-f]{40})$/m.exec(RECORD)
    expect(commit?.[1]).toBe(specEnginePin())
  })

  it('holds exactly the 10 production files and 8 test files SPEC §9 counts, plus VENDOR.md', () => {
    expect(production).toHaveLength(10)
    expect(tests).toHaveLength(8)
    expect(files).toEqual([...production, ...tests, 'VENDOR.md'].sort())
  })

  it('every vendored file hashes to the SHA-256 VENDOR.md records, and every file is recorded', () => {
    const recorded = recordedHashes()
    expect([...recorded.keys()].sort()).toEqual(files.filter((f) => f !== 'VENDOR.md'))
    for (const [file, sha] of recorded) expect(sha256(file), file).toBe(sha)
  })
})
