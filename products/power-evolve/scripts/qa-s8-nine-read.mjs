/** Read and verify all nine built-in SKILL.md bodies through each user's native cookie. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (!privateDir || !outputDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort))
  throw new Error('Set PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).slice(0, 2)
assert.deepEqual(users.map(user => user.username), ['alice', 'bob'])
const browser = await chromium.launch({ headless: true })
const sessions = []
async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: await response.json() }
  }, { name, request })
}
try {
  for (const user of users) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${platformPort}/login`)
    await page.getByRole('textbox', { name: '账号' }).fill(user.username)
    await page.getByRole('textbox', { name: '密码' }).fill(user.password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`http://127.0.0.1:${hostPort}/native/**`, { timeout: 30_000 })
    sessions.push({ user, context, page })
  }
  const results = []
  for (const session of sessions) {
    const listed = await rpc(session.page, 'skillsList', {})
    const catalog = await rpc(session.page, 'skillsCatalog', {})
    assert.equal(listed.status, 200)
    assert.equal(catalog.status, 200)
    assert.equal(catalog.body.items.length, 9)
    const rows = []
    for (const item of listed.body.items.filter(value => value.kind === 'package')) {
      const read = await rpc(session.page, 'skillsRead', { skillId: item.skillId })
      assert.equal(read.status, 200)
      assert.equal(read.body.name, item.name)
      assert.equal(read.body.digest, createHash('sha256').update(read.body.instructions).digest('hex'))
      assert.match(read.body.instructions, new RegExp(`name: ["']?${item.name}`, 'u'))
      rows.push({ name: item.name, skillId: item.skillId, digest: item.digest,
        packageDigest: item.packageDigest, bytes: Buffer.byteLength(read.body.instructions),
        enabled: item.enabled, state: item.observedState })
    }
    assert.equal(rows.length, 9)
    results.push({ username: session.user.username, rows: rows.sort((a, b) => a.name.localeCompare(b.name)) })
    console.log(`${session.user.username}: read and SHA-256 verified nine owner-scoped package instructions`)
  }
  assert.deepEqual(results[0].rows.map(row => row.name), results[1].rows.map(row => row.name))
  for (let index = 0; index < 9; index += 1) {
    const alice = results[0].rows[index]
    const bob = results[1].rows[index]
    assert.notEqual(alice.skillId, bob.skillId)
    assert.equal(alice.digest, bob.digest)
    assert.equal(alice.packageDigest, bob.packageDigest)
    assert.equal((await rpc(sessions[0].page, 'skillsRead', { skillId: bob.skillId })).status, 404)
    assert.equal((await rpc(sessions[1].page, 'skillsRead', { skillId: alice.skillId })).status, 404)
  }
  await writeFile(join(outputDir, 'nine-package-read.json'),
    `${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log('All nine cross-user reads rejected with 404; package bytes and digests agree across owners')
} finally {
  await Promise.all(sessions.map(session => session.context.close()))
  await browser.close()
}
