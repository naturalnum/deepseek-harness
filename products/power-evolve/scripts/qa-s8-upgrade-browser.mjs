/** Upgrade five pinned built-in Skills through two native browser identities. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (!privateDir || !outputDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort))
  throw new Error('Set PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
const expected = new Map([
  ['builtin.word', ['word-documents', '1.0.0', '1.0.1']],
  ['builtin.excel', ['excel-spreadsheets', '1.0.0', '1.0.1']],
  ['builtin.powerpoint', ['powerpoint-presentations', '1.0.0', '1.0.1']],
  ['builtin.latex-report-writer', ['latex-report-writer', '1.0.0', '1.0.1']],
  ['builtin.tech-report-writer', ['tech-report-writer', '1.1.31', '1.1.32']],
])
const catalogPath = new URL('../application/assets/builtin-skills/generated/catalog.json', import.meta.url)
const catalogDigest = createHash('sha256').update(await readFile(catalogPath)).digest('hex')
assert.equal(catalogDigest, 'a83063fea6ca0b35aab0bf28c3aaee8d8e36e29d927ecdf684dfb42a8ffa97df')
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).slice(0, 2)
assert.deepEqual(users.map(user => user.username), ['alice', 'bob'])
const sandbox = JSON.parse(await readFile(join(privateDir, 'sandbox.json'), 'utf8'))
assert.equal(sandbox.image, 'pe-s8-skills-runner:qa3')
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
await db.connect()
const browser = await chromium.launch({ headless: true })
async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: await response.json() }
  }, { name, request })
}
async function receiptRows(username, catalogId) {
  const result = await db.query(`SELECT r.request_id,r.version,v.skill_id,v.archive_digest
    FROM pe_builtin_skill_install_requests r JOIN pe_users u ON u.id=r.user_id
    JOIN pe_skill_package_versions v ON v.id=r.package_version_id
    WHERE u.username=$1 AND r.catalog_id=$2 ORDER BY r.version`, [username, catalogId])
  return result.rows
}
const contexts = []
try {
  const evidence = { checkedAt: new Date().toISOString(), image: sandbox.image, catalogDigest, users: [] }
  for (const user of users) {
    const userId = (await db.query('SELECT id FROM pe_users WHERE username=$1', [user.username])).rows[0]?.id
    assert(userId)
    const context = await browser.newContext()
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${platformPort}/login`)
    await page.getByRole('textbox', { name: '账号' }).fill(user.username)
    await page.getByRole('textbox', { name: '密码' }).fill(user.password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`http://127.0.0.1:${hostPort}/native/**`, { timeout: 30_000 })
    const catalogResponse = await rpc(page, 'skillsCatalog', {})
    assert.equal(catalogResponse.status, 200)
    assert.equal(catalogResponse.body.items.length, 9)
    const catalog = new Map(catalogResponse.body.items.map(item => [item.id, item]))
    const beforeResponse = await rpc(page, 'skillsList', {})
    assert.equal(beforeResponse.status, 200)
    const before = new Map(beforeResponse.body.items.map(item => [item.name, item]))
    const upgraded = []
    const ppt = before.get('powerpoint-presentations')
    if (user.username === 'alice') {
      assert.equal((await rpc(page, 'skillsToggle', { skillId: ppt.skillId, enabled: false })).status, 200)
    }
    for (const [id, [name, oldVersion, newVersion]] of expected) {
      const old = before.get(name)
      assert(old, `${user.username}: ${name} missing`)
      assert.equal(old.version, oldVersion)
      const release = catalog.get(id)
      assert(release, `${id} missing from catalog`)
      assert.equal(release.version, newVersion)
      assert.equal(release.installedSkillId, null)
      const oldReceipts = await receiptRows(user.username, id)
      assert(oldReceipts.some(row => row.version === oldVersion && row.skill_id === old.skillId))
      const oldInstruction = join(sandbox.localRoot, 'skill-packages', userId,
        'sha256', old.packageDigest, 'skill', 'SKILL.md')
      assert((await stat(oldInstruction)).size > 0)
      const requestId = randomUUID()
      const installed = await rpc(page, 'skillsInstallBuiltin', { requestId, catalogId: id, version: newVersion })
      assert.equal(installed.status, 200, `${id}: ${JSON.stringify(installed.body)}`)
      assert.equal(installed.body.skillId, old.skillId)
      assert.equal(installed.body.version, newVersion)
      assert.equal(installed.body.packageDigest, release.archiveDigest)
      if (user.username === 'alice' && id === 'builtin.powerpoint') assert.equal(installed.body.enabled, false)
      const rows = await receiptRows(user.username, id)
      assert(rows.some(row => row.version === oldVersion && row.skill_id === old.skillId))
      assert(rows.some(row => row.version === newVersion && row.skill_id === old.skillId
        && row.request_id === requestId))
      const newInstruction = join(sandbox.localRoot, 'skill-packages', userId,
        'sha256', release.archiveDigest, 'skill', 'SKILL.md')
      assert((await stat(newInstruction)).size > 0)
      upgraded.push({ catalogId: id, name, skillId: old.skillId, oldVersion, newVersion,
        oldDigest: old.packageDigest, newDigest: release.archiveDigest, requestId,
        oldReceiptCount: oldReceipts.length, receiptCount: rows.length })
    }
    if (user.username === 'alice') {
      const current = await rpc(page, 'skillsList', {})
      assert.equal(current.status, 200)
      assert.equal(current.body.items.find(item => item.name === 'powerpoint-presentations').enabled, false)
      assert.equal((await rpc(page, 'skillsToggle', { skillId: ppt.skillId, enabled: true })).status, 200)
    }
    const afterResponse = await rpc(page, 'skillsList', {})
    assert.equal(afterResponse.status, 200)
    for (const item of upgraded) {
      const now = afterResponse.body.items.find(value => value.skillId === item.skillId)
      assert.equal(now.version, item.newVersion)
      assert.equal(now.enabled, true)
      const read = await rpc(page, 'skillsRead', { skillId: item.skillId })
      assert.equal(read.status, 200)
      assert.equal(read.body.version, item.newVersion)
      assert.equal(createHash('sha256').update(read.body.instructions).digest('hex'), read.body.digest)
    }
    evidence.users.push({ username: user.username, userId, upgraded })
    console.log(`${user.username}: five explicit API upgrades; Skill IDs and old receipts preserved`)
  }
  await writeFile(join(outputDir, 'builtin-upgrades.json'), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
  await db.end()
}
