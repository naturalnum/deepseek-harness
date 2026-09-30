/** Local POSIX shell execution only; no Platform, Runner, database or service is started. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { PlatformError } from '../src/contracts.ts'
import { renderSshCommand } from '../src/platform/ssh-command.ts'

async function fixture(t: TestContext) {
  const created = await mkdtemp(join(tmpdir(), 'pe-ssh-command-'))
  t.after(async () => { await rm(created, { recursive: true, force: true }) })
  const root = await realpath(created)
  const home = join(root, 'remote home $literal')
  const initial = join(root, 'initial')
  const cdpath = join(root, 'cdpath')
  await mkdir(home); await mkdir(initial); await mkdir(cdpath)
  return { root, home, initial, cdpath }
}

function execute(command: string, directories: { home: string; initial: string; cdpath: string }) {
  return spawnSync('/bin/sh', ['-c', command], { cwd: directories.initial,
    env: { HOME: directories.home, CDPATH: directories.cdpath, PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    encoding: 'utf8', timeout: 2000, maxBuffer: 16_384 })
}

function invalid(operation: () => unknown, code: 'ssh_command_invalid' | 'ssh_working_directory_invalid'): void {
  assert.throws(operation, error => error instanceof PlatformError && error.status === 400 && error.code === code)
}

test('null preserves every command byte and the existing working directory', async t => {
  const directories = await fixture(t)
  const command = "printf '%s\\n' 'unchanged $HOME; *';\npwd -P # trailing comment"
  assert.equal(renderSshCommand(command, null), command)
  assert.equal(renderSshCommand(' ', null), ' ')
  const result = execute(renderSshCommand(command, null), directories)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `unchanged $HOME; *\n${directories.initial}\n`)
})

test('HOME, home-prefixed, relative and absolute directories resolve through the local POSIX shell', async t => {
  const directories = await fixture(t)
  const project = join(directories.home, 'project')
  const absolute = join(directories.root, 'absolute directory')
  await mkdir(project); await mkdir(absolute)
  await mkdir(join(directories.cdpath, 'project'))
  for (const [directory, expected] of [
    ['~', directories.home], ['~/', directories.home], ['~/project', project],
    ['project', project], [absolute, absolute],
  ]) {
    const result = execute(renderSshCommand('pwd -P', directory!), directories)
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${expected}\n`)
  }
  const result = execute(renderSshCommand("printf '%s' \"${CDPATH-unset}\"", 'project'), directories)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
})

test('quotes, spaces, dollars, command substitutions and glob characters remain directory literals', async t => {
  const directories = await fixture(t)
  const name = '  O\'Neil " $HOME `touch marker` $(touch marker) ;*? [abc] #\\  '
  const target = join(directories.home, name)
  await mkdir(target)
  for (const directory of [name, `~/${name}`, target]) {
    const result = execute(renderSshCommand('pwd -P', directory), directories)
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${target}\n`)
  }
  for (const directory of [directories.initial, directories.home, target]) {
    await assert.rejects(stat(join(directory, 'marker')), { code: 'ENOENT' })
  }
})

test('tilde usernames and variable-looking relative directories also stay literal under HOME', async t => {
  const directories = await fixture(t)
  for (const name of ['~somebody', '$HOME', '-option', '  ']) {
    const target = join(directories.home, name)
    await mkdir(target)
    const result = execute(renderSshCommand('pwd -P', name), directories)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${target}\n`)
  }
})

test('cd failure exits before the original OR branch or later command can run', async t => {
  const directories = await fixture(t)
  const commands = ['false || touch or-branch-marker', 'touch first-marker; false || touch later-marker',
    '(false) || { touch grouped-marker; }']
  for (const command of commands) {
    const result = execute(renderSshCommand(command, '~/missing-directory'), directories)
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
  }
  for (const name of ['or-branch-marker', 'first-marker', 'later-marker', 'grouped-marker']) {
    await assert.rejects(stat(join(directories.initial, name)), { code: 'ENOENT' })
    await assert.rejects(stat(join(directories.home, name)), { code: 'ENOENT' })
  }
})

test('an absent or empty HOME fails closed for HOME-relative directories', async t => {
  const directories = await fixture(t)
  for (const home of [undefined, '']) {
    const result = spawnSync('/bin/sh', ['-c', renderSshCommand('touch marker', 'project')], {
      cwd: directories.initial, env: { ...(home === undefined ? {} : { HOME: home }), PATH: '/usr/bin:/bin' },
      encoding: 'utf8', timeout: 2000, maxBuffer: 16_384,
    })
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
  }
  await assert.rejects(stat(join(directories.initial, 'marker')), { code: 'ENOENT' })
})

test('directory validation rejects empty, control, lossy UTF-8 and over-1024-character values independently', () => {
  for (const directory of ['', 'x'.repeat(1025), '\0', 'line\nfeed', '\t', '\r', '\u007f', '\u0085', '\ud800', '\udc00']) {
    invalid(() => renderSshCommand('true', directory), 'ssh_working_directory_invalid')
  }
  assert.ok(renderSshCommand('true', 'x'.repeat(1024)).endsWith('\ntrue'))
  assert.ok(renderSshCommand('true', '目录'.repeat(512)).endsWith('\ntrue'))
  invalid(() => renderSshCommand('true', '目录'.repeat(513)), 'ssh_working_directory_invalid')
  assert.ok(renderSshCommand('true', '😀'.repeat(512)).endsWith('\ntrue'))
  invalid(() => renderSshCommand('true', '😀'.repeat(513)), 'ssh_working_directory_invalid')
})

test('command validation and the complete rendered UTF-8 byte budget include quoting and directory prefix', () => {
  for (const command of ['', 'embedded\0nul', '\ud800', '\udc00', 'x'.repeat(16_385), '你'.repeat(5462)]) {
    invalid(() => renderSshCommand(command, null), 'ssh_command_invalid')
  }
  assert.equal(renderSshCommand('x'.repeat(16_384), null).length, 16_384)
  assert.equal(Buffer.byteLength(renderSshCommand('你'.repeat(5461) + 'x', null)), 16_384)
  const directory = "~/目录 O'Neil"
  const overhead = Buffer.byteLength(renderSshCommand('x', directory)) - 1
  const limit = 16_384 - overhead
  const original = '你'.repeat(Math.floor(limit / 3)) + 'x'.repeat(limit % 3)
  const rendered = renderSshCommand(original, directory)
  assert.equal(Buffer.byteLength(rendered), 16_384)
  assert.ok(rendered.endsWith(original))
  invalid(() => renderSshCommand(`${original}x`, directory), 'ssh_command_invalid')
  invalid(() => renderSshCommand('x'.repeat(16_384), "'".repeat(1024)), 'ssh_command_invalid')
})
