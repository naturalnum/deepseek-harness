/** Backup preflight uses a controlled kubectl executable; no cluster or service is started. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { requireNoKubernetesWriters } from '../../scripts/backup-support.mjs'

test('Office backup requires explicit current-context and absence even for finished or deleting parser Pods', () => {
  const office = { namespace: 'pe-office-backup-test', kubeconfigFile: '/synthetic/office-kubeconfig' }
  let items = [], recorded = []
  const run = (exe, args) => {
    assert.equal(exe, 'kubectl'); recorded.push(args)
    if (args[2] === 'config') return 'office-current'
    assert.deepEqual(args, ['--request-timeout=15s', '--kubeconfig', office.kubeconfigFile, '--context', 'office-current', '-n', office.namespace, 'get', 'pods', '-o', 'json'])
    return JSON.stringify({ items })
  }
  assert.doesNotThrow(() => requireNoKubernetesWriters({ office }, run))
  assert.deepEqual(recorded[0], ['--kubeconfig', office.kubeconfigFile, 'config', 'current-context'])
  for (const status of ['Running', 'Succeeded', 'Failed']) {
    items = [{ metadata: { name: 'pe-op-fixture', deletionTimestamp: '2026-10-01T00:00:00Z' }, status: { phase: status } }]
    assert.throws(() => requireNoKubernetesWriters({ office }, run), /Office preview Pods remain/u)
  }
  recorded = []
  assert.throws(() => requireNoKubernetesWriters({ office: { ...office, kubeconfigFile: 'relative' } }, run), /Invalid Office preview/u)
  assert.deepEqual(recorded, [])
  assert.throws(() => requireNoKubernetesWriters({ office }, () => '{}'), /Cannot verify Kubernetes writer absence/u)
})

test('SSH-only backup checks its configured cluster and rejects live or terminating Runner Pods',
  { skip: process.platform === 'win32' && 'Trial backup requires POSIX executables' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pe-backup-kube-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const control = join(directory, 'control.json'), log = join(directory, 'calls.jsonl')
    const kubectl = join(directory, 'kubectl')
    await writeFile(kubectl, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(process.env.PE_BACKUP_TEST_LOG, JSON.stringify(process.argv.slice(2))+'\\n')
const mode=JSON.parse(readFileSync(process.env.PE_BACKUP_TEST_CONTROL,'utf8'))
const context=process.argv[3].includes('sandbox')?'sandbox-current':'ssh-current'
if(process.argv[4]==='config') {
  if(mode.contextExit) process.exit(mode.contextExit)
  process.stdout.write(mode.contextOutput ?? context)
  process.exit(0)
}
if(process.argv[4]!=='--context'||process.argv[5]!==context) process.exit(2)
if(mode.exit) process.exit(mode.exit)
process.stdout.write(mode.raw ?? JSON.stringify({items:mode.items ?? []}))
`, { mode: 0o700 })
    const run = (exe, args) => {
      assert.equal(exe, 'kubectl')
      const result = spawnSync(kubectl, args, { encoding: 'utf8',
        env: { ...process.env, PE_KUBE_CONTEXT: 'unrelated-outer-context',
          PE_BACKUP_TEST_CONTROL: control, PE_BACKUP_TEST_LOG: log } })
      if (result.error || result.status !== 0) throw new Error('kubectl failed')
      return result.stdout
    }
    const configure = mode => writeFile(control, JSON.stringify(mode), { mode: 0o600 })
    const ssh = { namespace: 'pe-connector-backup-test', kubeconfigFile: '/synthetic/ssh-kubeconfig' }
    const sandbox = { namespace: 'pe-sandbox-backup-test', kubeconfigFile: '/synthetic/sandbox-kubeconfig' }
    const check = overrides => requireNoKubernetesWriters({ ssh, ...overrides }, run)
    const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))

    await t.test('SSH configuration alone enumerates Pods, including authentication canaries', async () => {
      for (const name of ['pe-cr-call', 'pe-cr-call-check', 'pe-mcp-call', 'pe-cr-terminating']) {
        await configure({ items: [{ metadata: { name, ...(name.endsWith('terminating')
          ? { deletionTimestamp: '2026-10-01T00:00:00Z' } : {}) }, status: { phase: 'Running' } }] })
        assert.throws(() => check(), /Connector Runner Pods remain active/u)
      }
      const recorded = await calls()
      assert.equal(recorded.length, 8)
      for (const [index, args] of recorded.entries()) assert.deepEqual(args, index % 2 === 0
        ? ['--kubeconfig', ssh.kubeconfigFile, 'config', 'current-context']
        : ['--kubeconfig', ssh.kubeconfigFile, '--context', 'ssh-current', '-n', ssh.namespace, 'get', 'pods', '-o', 'json'])
    })
    await t.test('SSH target servers are permitted; independent kubeconfigs use different current-context names', async () => {
      await configure({ items: [{ metadata: { name: 'ssh-target-fixture' } }] })
      assert.doesNotThrow(() => check())
      await configure({ items: [] })
      assert.doesNotThrow(() => check({ sandbox }))
      const recorded = await calls()
      assert.deepEqual(recorded.at(-4), ['--kubeconfig', sandbox.kubeconfigFile, 'config', 'current-context'])
      assert.deepEqual(recorded.at(-3), ['--kubeconfig', sandbox.kubeconfigFile,
        '--context', 'sandbox-current', '-n', sandbox.namespace, 'get', 'sandboxes.agents.x-k8s.io', '-o', 'json'])
      assert.deepEqual(recorded.at(-2), ['--kubeconfig', ssh.kubeconfigFile, 'config', 'current-context'])
      assert.deepEqual(recorded.at(-1), ['--kubeconfig', ssh.kubeconfigFile,
        '--context', 'ssh-current', '-n', ssh.namespace, 'get', 'pods', '-o', 'json'])
      await configure({ items: [{ metadata: { name: 'sandbox-writer' } }] })
      assert.throws(() => check({ sandbox }), /Sandbox objects remain active/u)
    })
    await t.test('missing context, invalid configuration and unavailable or malformed enumeration fail closed', async () => {
      const before = (await calls()).length
      assert.throws(() => check({ ssh: { ...ssh, kubeconfigFile: 'relative' } }), /Invalid SSH/u)
      assert.throws(() => check({ ssh: { ...ssh, namespace: '' } }), /Invalid Kubernetes/u)
      assert.equal((await calls()).length, before)
      for (const contextOutput of ['', ' ', '\n', 'ssh-current\nother']) {
        await configure({ contextOutput })
        assert.throws(() => check(), /Cannot verify Kubernetes writer current-context/u)
        assert.equal((await calls()).at(-1)[2], 'config', 'No namespace query follows an unverified context')
      }
      await configure({ contextExit: 1 })
      assert.throws(() => check(), /kubectl failed/u)
      for (const mode of [{ exit: 1 }, { raw: 'not json' }, { raw: '{}' }, { items: [{}] }]) {
        await configure(mode)
        assert.throws(() => check())
      }
    })
    await t.test('quarantine cannot substitute for a configured namespace to inspect', async () => {
      assert.throws(() => check({ ssh: null, sshRequired: true }), /Quarantined SSH calls require/u)
      assert.doesNotThrow(() => check({ ssh: null, sandbox: null }))
    })
  })
