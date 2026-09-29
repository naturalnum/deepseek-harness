/** Seed and verify two users' native history, files, Git, artifacts and connections. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const mode = process.argv[2]
const privateDir = process.env.PE_PRIVATE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
const evidenceFile = process.env.PE_S7C_EVIDENCE_FILE
const nativePane = process.env.PE_S7C_NATIVE_PANE ?? 'files'
if (!['seed', 'verify'].includes(mode) || !privateDir || !evidenceFile
  || !Number.isInteger(hostPort) || !Number.isInteger(platformPort)
  || !['files', 'artifacts'].includes(nativePane)) {
  throw new Error('Set seed|verify, PE_PRIVATE_DIR, PE_S7C_EVIDENCE_FILE, PE_HOST_PORT and PE_PLATFORM_PORT')
}
const hostOrigin = `http://127.0.0.1:${hostPort}`
const platformOrigin = `http://127.0.0.1:${platformPort}`
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).slice(0, 2)
assert.deepEqual(users.map(user => user.username), ['alice', 'bob'])
const sandbox = JSON.parse(await readFile(join(privateDir, 'sandbox.json'), 'utf8'))
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
const sessions = []
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', `safe.directory=${cwd}`, '-C', cwd, ...args], { encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed in isolated Workspace`)
  return result.stdout.trim()
}
async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: response.ok ? await response.json() : null }
  }, { name, request })
}
async function eventually(probe, accept, label, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  let last
  while (Date.now() < until) {
    last = await probe()
    if (accept(last)) return last
    await delay(500)
  }
  throw new Error(`${label} timed out; last ${JSON.stringify(last)}`)
}
async function ownedSession(username) {
  const result = await db.query(`SELECT u.id AS user_id,w.id AS workspace_id,
    w.title AS workspace_title,s.id AS session_id
    FROM pe_users u JOIN pe_stdio_mcp_calls c ON c.user_id=u.id
    JOIN pe_operations o ON o.id=c.operation_id
    JOIN pe_sessions s ON s.id=o.session_id
    JOIN pe_workspaces w ON w.id=s.workspace_id
    WHERE u.username=$1 AND c.state='succeeded' ORDER BY c.created_at DESC LIMIT 1`, [username])
  assert.equal(result.rows.length, 1)
  return result.rows[0]
}
try {
  for (const user of users) {
    const context = await browser.newContext()
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(`${platformOrigin}/login`)
    await page.getByRole('textbox', { name: '账号' }).fill(user.username)
    await page.getByRole('textbox', { name: '密码' }).fill(user.password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`${hostOrigin}/native/**`, { timeout: 20_000 })
    sessions.push({ user, page, owned: await ownedSession(user.username) })
  }
  if (mode === 'seed') {
    const outcomes = []
    for (const { user, page, owned } of sessions) {
      const marker = `s7c-${user.username}-${randomUUID()}`
      const file = `backup-${user.username}-${marker.slice(-8)}.txt`
      const skillName = `s7c-${user.username}-${marker.slice(-8)}`
      const bytes = Buffer.from(`${marker}\n`)
      const put = await rpc(page, 'filesPut', { sessionId: owned.session_id,
        requestId: randomUUID(), path: file, baseRevision: null, data: bytes.toString('base64') })
      assert.equal(put.status, 200)
      const published = await rpc(page, 'artifactsPublish', { requestId: randomUUID(),
        sessionId: owned.session_id, path: file })
      assert.equal(published.status, 200)
      const skill = await rpc(page, 'skillsInstall', { requestId: randomUUID(),
        name: skillName, description: 'Backup acceptance skill',
        instructions: `Remember ${marker} as test data.` })
      assert.equal(skill.status, 200)
      const connection = await rpc(page, 'stdioMcpList', {})
      assert.equal(connection.status, 200)
      const stdio = connection.body.items.find(item => item.name === `qa-stdio-${user.username}`)
      assert.ok(stdio?.enabled)
      const cwd = join(sandbox.workspaceRoot, owned.workspace_id)
      git(cwd, 'init', '-q')
      git(cwd, 'config', 'user.name', 'S7c QA')
      git(cwd, 'config', 'user.email', 's7c@example.invalid')
      git(cwd, 'add', file)
      git(cwd, 'commit', '-qm', `Save ${user.username} backup acceptance file`)
      const gitHead = git(cwd, 'rev-parse', 'HEAD')
      const homeFile = `home-${marker.slice(-8)}.txt`
      const packageFile = `package-${marker.slice(-8)}.txt`
      for (const [directory, name] of [['homes', homeFile], ['skill-packages', packageFile]]) {
        const owner = join(sandbox.localRoot, directory, owned.user_id)
        await mkdir(owner, { recursive: true, mode: directory === 'skill-packages' ? 0o755 : 0o700 })
        await writeFile(join(owner, name), `${marker}:${directory}\n`, { mode: 0o600, flag: 'wx' })
      }
      outcomes.push({ username: user.username, ...owned, marker, file, skillName, homeFile, packageFile,
        artifactId: published.body.artifactId, connectionId: stdio.connectionId,
        connectionRevision: stdio.revision, gitHead })
      console.log(`${user.username}: native account, Session, POSIX file, Git commit, artifact, skill and STDIO connection seeded`)
    }
    await writeFile(evidenceFile, `${JSON.stringify({ outcomes, seededAt: Date.now() }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' })
    await chmod(evidenceFile, 0o600)
  } else {
    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.deepEqual(evidence.outcomes.map(item => item.username), ['alice', 'bob'])
    for (const [index, { user, page, owned }] of sessions.entries()) {
      const item = evidence.outcomes[index]
      assert.equal(owned.user_id, item.user_id)
      assert.equal(owned.workspace_id, item.workspace_id)
      assert.equal(owned.session_id, item.session_id)
      const ownRead = await rpc(page, 'filesRead', { sessionId: item.session_id, path: item.file })
      assert.equal(ownRead.status, 200)
      assert.equal(Buffer.from(ownRead.body.data, 'base64').toString(), `${item.marker}\n`)
      const artifact = await rpc(page, 'artifactsPreview', { artifactId: item.artifactId })
      assert.equal(artifact.status, 200)
      assert.equal(artifact.body.text, `${item.marker}\n`)
      const stdio = await rpc(page, 'stdioMcpList', {})
      assert.equal(stdio.status, 200)
      assert.ok(stdio.body.items.some(value => value.connectionId === item.connectionId
        && value.revision === item.connectionRevision && value.enabled))
      const skills = await rpc(page, 'skillsList', {})
      assert.equal(skills.status, 200)
      assert.ok(skills.body.items.some(value => value.name === item.skillName))
      const cwd = join(sandbox.workspaceRoot, item.workspace_id)
      assert.equal(git(cwd, 'rev-parse', 'HEAD'), item.gitHead)
      assert.equal(git(cwd, 'show', 'HEAD:'+item.file), `${item.marker}`)
      for (const [directory, name] of [['homes', item.homeFile], ['skill-packages', item.packageFile]]) {
        assert.equal(await readFile(join(sandbox.localRoot, directory, item.user_id, name), 'utf8'),
          `${item.marker}:${directory}\n`)
      }
      const other = evidence.outcomes[1 - index]
      assert.equal((await rpc(page, 'filesRead', { sessionId: other.session_id, path: other.file })).status, 404)
      assert.equal((await rpc(page, 'artifactsPreview', { artifactId: other.artifactId })).status, 404)
      assert.equal((await rpc(page, 'stdioMcpToggle', { connectionId: other.connectionId,
        requestId: randomUUID(), baseRevision: other.connectionRevision, enabled: false })).status, 404)
      await page.locator(`[data-row-key="session:${item.session_id}"]`).click()
      assert.equal(await page.locator(`[data-row-key="session:${item.session_id}"]`).getAttribute('aria-selected'), 'true')
      await eventually(async () => (await page.locator('body').innerText()).includes(`user:${item.user_id}`),
        Boolean, `${user.username} native historical transcript`)
      const expand = page.locator('[data-sidebar-right-expand]').last()
      if (await expand.isVisible()) await expand.click()
      if (nativePane === 'files') {
        await page.locator('[data-sidebar-right-guide-entry="files"]').click()
        await page.getByText(item.file, { exact: true }).first().waitFor({ timeout: 20_000 })
      } else {
        await page.locator('[data-sidebar-right-guide-entry="powerEvolveArtifacts"]').click()
        const published = page.locator('[data-artifacts-tab] .pe-artifacts-item')
          .filter({ hasText: item.file })
        await published.waitFor({ timeout: 20_000 })
        await published.getByRole('button', { name: 'Preview' }).click()
        await published.locator('pre').getByText(item.marker, { exact: true }).waitFor({ timeout: 20_000 })
      }
      await page.getByText('Plugins', { exact: true }).first().click()
      await page.getByRole('tab', { name: /All plugins/u }).click()
      await page.locator('[data-plugin-id="stdio"] button').first().click()
      await page.getByRole('switch', { name: `qa-stdio-${user.username} Enable plugin` }).waitFor()
      console.log(`${user.username}: restored native workspace and Plugins, history IDs, Git/file, artifact, skill, home/package and cross-user 404 verified`)
    }
    if (process.env.PE_S7C_VERIFICATION_OUTPUT) {
      await writeFile(process.env.PE_S7C_VERIFICATION_OUTPUT,
        `${JSON.stringify({ nativePane, verifiedAt: Date.now(), users: 2 }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' })
    }
  }
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
  await db.end()
}
