/** Pure fixture checks use the current account parser; no Docker command or application process is started. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountManagementConfig, loadAccountManagementConfig } from '../application/src/platform/account-config.ts'
import { createStartupAccountFiles, disposableContainerLimits } from './qa-s7d-image-startup.mjs'

test('startup private account files satisfy the current parser and seed settings', async () => {
  const { users, files } = createStartupAccountFiles()
  const policy = await loadAccountManagementConfig('/qa/private/account-management.json',
    async () => files['account-management.json'])
  assert.equal(policy.maxUsers, users.length)
  assert.deepEqual(JSON.parse(files['users.json']), users)
  for (const user of users) {
    assert.deepEqual(user.models, policy.models)
    const model = policy.models.find(item => item.id === user.settings.model)
    assert.ok(model && model.maxTokens >= user.settings.maxTokens)
    assert.ok(user.password.length >= 24)
  }
  assert.deepEqual(policy.initialSettings, { model: users[0].settings.model, maxTokens: users[0].settings.maxTokens })
})

test('the real policy loader rejects missing policy and settings outside its model catalog', async () => {
  const { files } = createStartupAccountFiles()
  await assert.rejects(loadAccountManagementConfig('/qa/private/account-management.json',
    async () => undefined), /Invalid account management configuration/u)
  const policy = JSON.parse(files['account-management.json'])
  assert.equal(accountManagementConfig.safeParse({ ...policy,
    initialSettings: { ...policy.initialSettings, maxTokens: policy.models[0].maxTokens + 1 } }).success, false)
})

test('every disposable role has finite CPU and memory limits with no additional swap', () => {
  let steadyCpu = 0, steadyMemory = 0
  for (const role of ['probe', 'pg', 'platform', 'host']) {
    const args = disposableContainerLimits(role)
    const options = Object.fromEntries([0, 2, 4].map(index => [args[index], args[index + 1]]))
    assert.ok(Number(options['--cpus']) > 0 && Number(options['--cpus']) <= 1)
    assert.match(options['--memory'], /^[1-9][0-9]*[mg]$/u)
    assert.equal(options['--memory-swap'], options['--memory'])
    if (role !== 'probe') {
      steadyCpu += Number(options['--cpus'])
      steadyMemory += Number.parseInt(options['--memory'], 10) * (options['--memory'].endsWith('g') ? 1024 : 1)
    }
  }
  assert.ok(steadyCpu <= 2.5)
  assert.ok(steadyMemory <= 2560)
  assert.throws(() => disposableContainerLimits('unlimited'), /Unknown disposable container role/u)
})
