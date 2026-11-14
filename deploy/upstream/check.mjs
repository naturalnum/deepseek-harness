#!/usr/bin/env node
/** Compare the current checkout's upstream source changes with the four-column ledger. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const own = /^(?:packages\/cloud\/|integrations\/epri-research\/|packages\/community\/|deploy\/)/u
const test = /(?:\.(?:spec|test)\.[tj]sx?$|\/tests?\/|__snapshots__|\.snap$|^snapshots\/)/u
const doc = /(?:\.(?:md|mdx)$|^docs\/|i18n\.ya?ml$)/u
const config = /(?:package\.json$|pnpm-lock|pnpm-workspace|tsconfig|\.ya?ml$|\.json$|Makefile|\.toml$)/u
const source = /\.(?:ts|tsx|js|mjs|cjs|py|c|h|css|scss|sh)$/u

function main() {
  if (process.argv.length !== 3) throw new Error('Usage: deploy/upstream/check <upstream-base>')
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const base = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${process.argv[2]}^{commit}`],
    { cwd: root, encoding: 'utf8' }).trim()
  const fields = execFileSync('git', ['diff', '--name-status', '-z', '-M', base, '--'],
    { cwd: root, encoding: 'utf8' }).split('\0')
  const changed = new Set()
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++]
    let path = fields[index++]
    if (status.startsWith('R') || status.startsWith('C')) path = fields[index++]
    if (!status.startsWith('A') && !own.test(path) && !test.test(path) && !doc.test(path)
      && !config.test(path) && source.test(path)) changed.add(path)
  }
  const lines = readFileSync(join(root, 'deploy/upstream/ledger.tsv'), 'utf8').trimEnd().split('\n')
  if (lines.shift() !== '路径\t类别\t原因\t撤销条件') throw new Error('ledger.tsv must have four named columns.')
  const ledger = new Set()
  for (const [index, line] of lines.entries()) {
    const columns = line.split('\t')
    if (columns.length !== 4 || columns.some(value => value.length === 0)) {
      throw new Error(`ledger.tsv line ${index + 2} must contain four nonempty columns.`)
    }
    const path = columns[0]
    if (ledger.has(path)) throw new Error(`Duplicate ledger path: ${path}`)
    ledger.add(path)
  }
  const missing = [...changed].filter(path => !ledger.has(path)).sort()
  const stale = [...ledger].filter(path => !changed.has(path)).sort()
  if (missing.length || stale.length) {
    if (missing.length) console.error('Unlisted upstream source:\n' + missing.join('\n'))
    if (stale.length) console.error('Ledger paths without upstream changes:\n' + stale.join('\n'))
    return 1
  }
  console.log(`upstream check: ${changed.size} changed source files; ${ledger.size} ledger rows; matched.`)
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
