#!/usr/bin/env node
/** Compare the current checkout's upstream source changes with the four-column ledger. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const own = /^(?:packages\/cloud\/|integrations\/epri-research\/|packages\/community\/|deploy\/)/u
const test = /(?:\.(?:spec|test)\.[tj]sx?$|\/tests?\/|__snapshots__|\.snap$|^snapshots\/)/u
const doc = /(?:\.(?:md|mdx)$|^docs\/|i18n\.ya?ml$)/u
const config = /(?:package\.json$|pnpm-lock|pnpm-workspace|tsconfig|\.ya?ml$|\.json$|Makefile|\.toml$)/u
const source = /\.(?:ts|tsx|js|mjs|cjs|py|c|h|css|scss|sh)$/u

function main() {
  if (process.argv.length !== 3 && !(process.argv.length === 4 && process.argv[3] === '--counts')) {
    throw new Error('Usage: deploy/upstream/check <upstream-base> [--counts]')
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const base = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${process.argv[2]}^{commit}`],
    { cwd: root, encoding: 'utf8' }).trim()
  const inventory = fileURLToPath(new URL('./seams_inventory.py', import.meta.url))
  if (process.argv[3] === '--counts') {
    process.stdout.write(execFileSync('python3', [inventory, base, '--repo', root, '--counts'], { encoding: 'utf8' }))
    return 0
  }
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
  const header = lines.shift()
  const extended = header === '路径\t类别\t原因\t撤销条件\t处置\t这一程的状态'
  if (!extended && header !== '路径\t类别\t原因\t撤销条件') throw new Error('ledger.tsv must have four or six named columns.')
  const ledger = new Set()
  const withdrawn = new Set()
  for (const [index, line] of lines.entries()) {
    const columns = line.split('\t')
    if (columns.length !== (extended ? 6 : 4) || columns.some(value => value.length === 0)) {
      throw new Error(`ledger.tsv line ${index + 2} has empty or missing columns.`)
    }
    const path = columns[0]
    if (ledger.has(path)) throw new Error(`Duplicate ledger path: ${path}`)
    ledger.add(path)
    if (extended) {
      if (!['留作口子', '搬进插件', '撤掉', '必须携带'].includes(columns[4])) {
        throw new Error(`Invalid disposition for ${path}: ${columns[4]}`)
      }
      if (!['没动', '已按新原生重加', '已验证', '已撤', '已搬'].includes(columns[5])) {
        throw new Error(`Invalid stage status for ${path}: ${columns[5]}`)
      }
      if (['已撤', '已搬'].includes(columns[5])) withdrawn.add(path)
    }
  }
  const missing = [...changed].filter(path => !ledger.has(path)).sort()
  const stale = [...ledger].filter(path => !changed.has(path) && !withdrawn.has(path)).sort()
  if (missing.length || stale.length) {
    if (missing.length) console.error('Unlisted upstream source:\n' + missing.join('\n'))
    if (stale.length) console.error('Ledger paths without upstream changes:\n' + stale.join('\n'))
    return 1
  }
  if (extended) {
    const result = execFileSync('python3', [inventory, base, '--repo', root, '--check-centralized'], { encoding: 'utf8' })
    process.stdout.write(result)
  }
  console.log(`upstream check: ${changed.size} changed source files; ${ledger.size} ledger rows; matched.`)
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(error.message)
  process.exitCode = Number.isInteger(error.status) ? error.status : 2
}
