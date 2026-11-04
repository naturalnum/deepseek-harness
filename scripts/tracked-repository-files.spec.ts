import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { trackedRepositoryFiles } from './tracked-repository-files.ts'

it('retains the inventory tail beyond one MiB and preserves unquoted pathnames', (test) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tracked-inventory-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '', encoding: 'utf8' }).trim()
  const paths = Array.from({ length: 10000 }, (_, i) => `packages/${String(i).padStart(5, '0')}/${'a'.repeat(100)}.ts`)
  paths.push('docs/中文.md', 'docs/line\nbreak.md', 'zz-last-policy-target.md')
  const inventory = paths.map(path => `100644 ${blob}\t${path}\0`).join('')
  execFileSync('git', ['update-index', '-z', '--index-info'], { cwd: root, input: inventory })
  expect(Buffer.byteLength(paths.join('\0'))).toBeGreaterThan(1024 * 1024)
  expect(trackedRepositoryFiles(root)).toEqual([...paths].sort())
})
