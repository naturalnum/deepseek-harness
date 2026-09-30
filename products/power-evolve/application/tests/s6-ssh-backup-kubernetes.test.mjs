/** Backup preflight uses a controlled kubectl executable; no cluster or service is started. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { requireNoKubernetesWriters } from '../../scripts/backup-support.mjs'

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
if(mode.exit) process.exit(mode.exit)
process.stdout.write(mode.raw ?? JSON.stringify({items:mode.items ?? []}))
`, { mode: 0o700 })
    const run = (exe, args) => {
      assert.equal(exe, 'kubectl')
      const result = spawnSync(kubectl, args, { encoding: 'utf8',
        env: { ...process.env, PE_BACKUP_TEST_CONTROL: control, PE_BACKUP_TEST_LOG: log } })
      if (result.error || result.status !== 0) throw new Error('kubectl failed')
      return result.stdout
    }
    const configure = mode => writeFile(control, JSON.stringify(mode), { mode: 0o600 })
    const ssh = { namespace: 'pe-connector-backup-test', kubeconfigFile: '/synthetic/ssh-kubeconfig' }
    const sandbox = { namespace: 'pe-sandbox-backup-test', kubeconfigFile: '/synthetic/sandbox-kubeconfig' }
    const check = overrides => requireNoKubernetesWriters({ ssh, kubeContext: 'backup-test', ...overrides }, run)
    const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))

    await t.test('SSH configuration alone enumerates Pods, including authentication canaries', async () => {
      for (const name of ['pe-cr-call', 'pe-cr-call-check', 'pe-mcp-call', 'pe-cr-terminating']) {
        await configure({ items: [{ metadata: { name, ...(name.endsWith('terminating')
          ? { deletionTimestamp: '2026-10-01T00:00:00Z' } : {}) }, status: { phase: 'Running' } }] })
        assert.throws(() => check(), /Connector Runner Pods remain active/u)
      }
      const recorded = await calls()
      assert.equal(recorded.length, 4)
      for (const args of recorded) assert.deepEqual(args, ['--kubeconfig', ssh.kubeconfigFile,
        '--context', 'backup-test', '-n', ssh.namespace, 'get', 'pods', '-o', 'json'])
    })
    await t.test('SSH target servers are permitted; Sandbox and SSH checks use their own kubeconfigs', async () => {
      await configure({ items: [{ metadata: { name: 'ssh-target-fixture' } }] })
      assert.doesNotThrow(() => check())
      await configure({ items: [] })
      assert.doesNotThrow(() => check({ sandbox }))
      const recorded = await calls()
      assert.deepEqual(recorded.at(-2), ['--kubeconfig', sandbox.kubeconfigFile,
        '--context', 'backup-test', '-n', sandbox.namespace, 'get', 'sandboxes.agents.x-k8s.io', '-o', 'json'])
      assert.deepEqual(recorded.at(-1), ['--kubeconfig', ssh.kubeconfigFile,
        '--context', 'backup-test', '-n', ssh.namespace, 'get', 'pods', '-o', 'json'])
      await configure({ items: [{ metadata: { name: 'sandbox-writer' } }] })
      assert.throws(() => check({ sandbox }), /Sandbox objects remain active/u)
    })
    await t.test('missing context, invalid configuration and unavailable or malformed enumeration fail closed', async () => {
      const before = (await calls()).length
      for (const kubeContext of [undefined, '', ' ']) assert.throws(() => check({ kubeContext }), /PE_KUBE_CONTEXT/u)
      assert.throws(() => check({ ssh: { ...ssh, kubeconfigFile: 'relative' } }), /Invalid SSH/u)
      assert.throws(() => check({ ssh: { ...ssh, namespace: '' } }), /Invalid Kubernetes/u)
      assert.equal((await calls()).length, before)
      for (const mode of [{ exit: 1 }, { raw: 'not json' }, { raw: '{}' }, { items: [{}] }]) {
        await configure(mode)
        assert.throws(() => check())
      }
    })
    await t.test('quarantine cannot substitute for a configured namespace to inspect', async () => {
      assert.throws(() => check({ ssh: null, sshRequired: true }), /Quarantined SSH calls require/u)
      assert.doesNotThrow(() => check({ ssh: null, sandbox: null, kubeContext: undefined }))
    })
  })
