/** Exercise the native Skills UI with two real, isolated browser identities. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
const namespace = process.env.PE_S8_NAMESPACE
if (!['seed', 'verify'].includes(mode) || !privateDir || !outputDir || !namespace
  || !Number.isInteger(hostPort) || !Number.isInteger(platformPort)) {
  throw new Error('Set seed|verify, PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_S8_NAMESPACE, PE_HOST_PORT and PE_PLATFORM_PORT')
}
const hostOrigin = `http://127.0.0.1:${hostPort}`
const platformOrigin = `http://127.0.0.1:${platformPort}`
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).slice(0, 2)
assert.deepEqual(users.map(user => user.username), ['alice', 'bob'])
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const builtinNames = ['excel-spreadsheets', 'latex-report-writer', 'pdf',
  'power-grid-technical-report-writer', 'powerpoint-presentations', 'report-reviewer',
  'report-workflow-orchestrator', 'tech-report-writer', 'word-documents']
const evidencePath = join(outputDir, 'native-skills.json')

function pods() {
  const result = spawnSync('kubectl', ['--context', 'k3d-pe-e32-session-probe', '-n', namespace,
    'get', 'pods', '-o', 'json'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Cannot list isolated Sandbox pods')
  return JSON.parse(result.stdout).items.map(item => item.metadata.name)
}
async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: await response.json() }
  }, { name, request })
}
async function list(page) {
  const response = await rpc(page, 'skillsList', {})
  assert.equal(response.status, 200)
  return response.body.items
}
async function login(browser, user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  await page.goto(`${platformOrigin}/login`)
  await page.getByRole('textbox', { name: '账号' }).fill(user.username)
  await page.getByRole('textbox', { name: '密码' }).fill(user.password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(`${hostOrigin}/native/**`, { timeout: 30_000 })
  await page.getByText('Skills', { exact: true }).first().click()
  await page.locator('[data-power-evolve-skills-page]').waitFor({ timeout: 20_000 })
  return { context, page }
}
async function checkDefault(page, username) {
  const skills = await list(page)
  assert.deepEqual(skills.map(item => item.name).filter(name => builtinNames.includes(name)).sort(), builtinNames)
  assert(skills.filter(item => builtinNames.includes(item.name)).every(item =>
    item.kind === 'package' && item.enabled && item.observedState === 'ready'))
  const catalog = await rpc(page, 'skillsCatalog', {})
  assert.equal(catalog.status, 200)
  assert.equal(catalog.body.items.length, 9)
  await page.getByRole('tab', { name: /My skills/u }).click()
  await page.locator('.pext-card-grid article').first().waitFor({ timeout: 20_000 })
  await page.getByRole('searchbox', { name: 'Search my skills' }).fill('word-documents')
  assert.equal(await page.locator('.pext-card-grid article').count(), 1)
  await page.getByRole('searchbox', { name: 'Search my skills' }).fill('')
  await page.getByRole('tab', { name: 'All skills' }).click()
  await page.getByRole('searchbox', { name: 'Search all skills' }).fill('builtin.word')
  assert.equal(await page.locator('.pext-card-grid article').count(), 1)
  await page.getByRole('searchbox', { name: 'Search all skills' }).fill('')
  await page.getByRole('tab', { name: /My skills/u }).click()
  await page.getByRole('button', { name: 'word-documents', exact: true }).click()
  const detail = page.locator('[data-skill-detail]')
  await detail.locator('.pext-skill-document-reader').getByText(/Word/u).first().waitFor({ timeout: 20_000 })
  assert((await detail.locator('.pext-skill-document-reader').innerText()).length > 100)
  await page.screenshot({ path: join(outputDir, `${username}-word-detail.png`), fullPage: true })
  await page.getByRole('button', { name: 'Close' }).last().click()
  return { skills, catalog: catalog.body.items }
}

await mkdir(outputDir, { recursive: true, mode: 0o700 })
const beforePods = pods()
const browser = await chromium.launch({ headless: true })
const sessions = []
try {
  for (const user of users) sessions.push({ user, ...await login(browser, user) })
  const [alice, bob] = sessions
  if (mode === 'seed') {
    // A previous interrupted seed may have completed the asynchronous switch RPC.
    const previousWord = (await list(alice.page)).find(item => item.name === 'word-documents')
    if (!previousWord.enabled) {
      assert.equal((await rpc(alice.page, 'skillsToggle', { skillId: previousWord.skillId, enabled: true })).status, 200)
      await alice.page.getByRole('button', { name: 'Refresh list' }).click()
    }
    const defaults = []
    for (const session of sessions) {
      defaults.push(await checkDefault(session.page, session.user.username))
      console.log(`${session.user.username}: native My/All, nine built-ins, search and document preview verified`)
    }
    const aliceWord = defaults[0].skills.find(item => item.name === 'word-documents')
    const bobWord = defaults[1].skills.find(item => item.name === 'word-documents')
    assert.notEqual(aliceWord.skillId, bobWord.skillId)
    assert.equal((await rpc(bob.page, 'skillsRead', { skillId: aliceWord.skillId })).status, 404)
    assert.equal((await rpc(alice.page, 'skillsRead', { skillId: bobWord.skillId })).status, 404)
    const aliceSwitch = alice.page.getByRole('switch', { name: 'word-documents Enable skill' })
    await aliceSwitch.click()
    await alice.page.waitForFunction(() => document.querySelector('[aria-label="word-documents Enable skill"]')?.getAttribute('aria-checked') === 'false')
    assert.equal((await list(alice.page)).find(item => item.skillId === aliceWord.skillId).enabled, false)
    assert.equal((await list(bob.page)).find(item => item.skillId === bobWord.skillId).enabled, true)
    await aliceSwitch.click()
    await alice.page.waitForFunction(() => document.querySelector('[aria-label="word-documents Enable skill"]')?.getAttribute('aria-checked') === 'true')
    assert.equal((await list(alice.page)).find(item => item.skillId === aliceWord.skillId).enabled, true)
    const disposableName = `qa-s8-revoke-${randomUUID().slice(0, 8)}`
    const installed = await rpc(alice.page, 'skillsInstall', { requestId: randomUUID(),
      name: disposableName, description: 'S8 owner scope and revoke check',
      instructions: 'This is a disposable text skill for the S8 browser acceptance.' })
    assert.equal(installed.status, 200)
    assert.equal((await rpc(bob.page, 'skillsRead', { skillId: installed.body.skillId })).status, 404)
    await alice.page.getByRole('button', { name: 'Refresh list' }).click()
    await alice.page.getByRole('button', { name: disposableName, exact: true }).click()
    await alice.page.locator(`[data-skill-detail="${installed.body.skillId}"]`).waitFor()
    await alice.page.getByRole('button', { name: 'Revoke skill' }).click()
    await alice.page.getByRole('button', { name: 'Confirm revoke' }).click()
    assert.equal((await list(alice.page)).find(item => item.skillId === installed.body.skillId).observedState, 'revoked')
    const afterPods = pods()
    assert.deepEqual(afterPods, beforePods, 'Document preview and mutations must not start a Sandbox')
    const evidence = { checkedAt: new Date().toISOString(), hostOrigin, platformOrigin, namespace,
      beforePods, afterPods, users: [alice.user.username, bob.user.username],
      builtinNames, wordIds: [aliceWord.skillId, bobWord.skillId],
      disposable: { name: disposableName, skillId: installed.body.skillId, owner: alice.user.username } }
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(evidencePath, 0o600)
    console.log('Alice toggle/revoke, Bob isolation and zero Sandbox pods verified')
  } else {
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    assert.deepEqual(evidence.users, users.map(user => user.username))
    for (const session of sessions) {
      const skills = await list(session.page)
      assert.deepEqual(skills.map(item => item.name).filter(name => builtinNames.includes(name)).sort(), builtinNames)
      await session.page.locator('.pext-card-grid article').first().waitFor({ timeout: 20_000 })
    }
    const aliceList = await list(alice.page)
    const bobList = await list(bob.page)
    assert.equal(aliceList.find(item => item.skillId === evidence.disposable.skillId).observedState, 'revoked')
    assert.equal(bobList.find(item => item.skillId === evidence.disposable.skillId), undefined)
    assert.equal((await rpc(bob.page, 'skillsRead', { skillId: evidence.disposable.skillId })).status, 404)
    assert(aliceList.some(item => item.skillId === evidence.wordIds[0] && item.enabled))
    assert(bobList.some(item => item.skillId === evidence.wordIds[1] && item.enabled))
    console.log('Both native accounts retained owner-scoped nine built-ins and Alice revoked text skill after restart')
  }
} finally {
  await Promise.all(sessions.map(session => session.context.close()))
  await browser.close()
}
