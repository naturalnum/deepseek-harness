/** Optional MCP outage checks; browser actions and the owned server have separate observations. */
import { randomBytes } from 'node:crypto'
import { createMcpSmokeFixture } from './mcp-fixture.mjs'

/** Fixed user-facing diagnostics; original causes remain internal. */
export class McpSmokeFailure extends Error {
  constructor(message, options) { super(message, options); this.name = 'McpSmokeFailure' }
}
function requireThat(value, message) { if (!value) throw new McpSmokeFailure(message) }

/** Remove only this run's attempted save after observing its exact name and URL.
 * No attempted save means no account read. Missing rows confirm absence; changed or ambiguous rows fail closed.
 * @param input Attempted-save ownership, confirmed login and scoped list/remove actions.
 * @returns Whether this run never saved, is confirmed absent, or was removed.
 */
export async function removeMcpSmokeConnection({ saveAttempted, authenticated, name, url, find, remove }) {
  if (!saveAttempted) return 'not-added'
  requireThat(authenticated, '本轮 MCP 连接清理需要已确认的登录')
  const candidates = await find()
  if (candidates.length === 0) return 'absent'
  requireThat(candidates.length === 1 && candidates[0].name === name && candidates[0].url === url,
    '本轮 MCP 连接身份变化或不唯一，未执行移除')
  await remove()
  return 'removed'
}

/** Keep recovery tied to the exact connection and successfully completed outage check.
 * Recovery records an already revoked or retained registration snapshot; it never forces a zero state.
 * @param fixture This run's service and actual invocation observations.
 * @param actions Browser actions owned by the original smoke runner.
 * @param serverName Unique connection name created by this run.
 * @returns Finite checks with separate probe, registry and actual-call observations, plus owned cleanup.
 */
export function mcpChecks(fixture, actions, serverName) {
  const tool = `mcp__${serverName}__ping`
  let offlineAttempted = false, offlineComplete = false, recoveryAttempted = false
  async function invoke() {
    const before = fixture.calls.length
    try { await actions.invoke(tool, fixture.marker) }
    finally {
      try { console.warn('MCP smoke calls: %j', { before, after: fixture.calls.length, delta: fixture.calls.length - before }) } catch (_diagnosticFailure) {}
    }
    requireThat(fixture.calls.length === before + 1, '未确认本轮 MCP 工具实际执行一次')
    return fixture.calls.length - before
  }
  return {
    async offline(signal) {
      requireThat(!offlineAttempted, 'MCP 掉线检查不能重复执行')
      offlineAttempted = true
      signal.throwIfAborted()
      const probeToolCount = await actions.add(serverName, fixture.url)
      requireThat(probeToolCount > 0, '本轮 MCP 连通测试未发现工具')
      const registeredToolCount = await actions.waitRegistered(serverName, count => count > 0, signal)
      signal.throwIfAborted()
      const actualCallDelta = await invoke()
      await fixture.stop()
      requireThat(fixture.state === 'stopped', 'MCP 服务停止未确认')
      signal.throwIfAborted()
      await actions.signOut()
      await actions.signIn()
      await actions.newConversation()
      await actions.command()
      offlineComplete = true
      return { probeToolCount, registeredToolCount, actualCallDelta }
    },
    async recover(signal) {
      requireThat(offlineComplete && !recoveryAttempted && fixture.state === 'stopped', 'MCP 恢复检查缺少同轮掉线前态')
      recoveryAttempted = true
      const registeredBefore = await actions.registrationCount(serverName, signal)
      requireThat(Number.isSafeInteger(registeredBefore) && registeredBefore >= 0, '未确认本轮 MCP 恢复前注册数')
      const branch = registeredBefore === 0 ? 'revoked' : 'retained'
      signal.throwIfAborted()
      await fixture.restart()
      signal.throwIfAborted()
      const probeToolCount = await actions.testOnce(serverName)
      requireThat(probeToolCount > 0, '原连接测试未发现本轮 MCP 工具')
      const registeredAfter = await actions.waitRegistered(serverName, count => count > 0, signal)
      signal.throwIfAborted()
      await actions.newConversation()
      const actualCallDelta = await invoke()
      return { branch, registeredBefore, probeToolCount, registeredAfter, actualCallDelta }
    },
    cleanupConnection: authenticated => actions.cleanupConnection(authenticated),
    close: () => fixture.close(),
  }
}

const title = /^(MCP connections|MCP 连接)$/
const label = {
  name: /^(Server name|服务名称)$/,
  url: /^(MCP endpoint URL|MCP 服务地址)$/,
  test: /^(Test connection|测试连接)$/,
  success: /^(Connection test succeeded|连接测试成功)/,
}

/** Navigate through the Cloud account menu and close only the settings panel this owner opened.
 * An already visible panel is borrowed. A replaced page or unconfirmed open/close remains a failure.
 * @param getPage The original runner's current page, including replacements after cancellation.
 * @param remaining The original step's remaining work time; no separate timeout or retry.
 * @returns Settings entry and owned-panel cleanup using the original UI controls.
 */
export function createMcpSettingsNavigation(getPage, remaining) {
  let owned, openingPage
  async function close() {
    requireThat(openingPage === undefined, '本轮设置面板打开结果未确认')
    if (owned === undefined) return
    const { page, element } = owned
    requireThat(page === getPage() && !page.isClosed(), '本轮设置面板所属页面已变化或失联')
    if (await element.isVisible()) {
      requireThat(!owned.closeAttempted, '本轮设置面板关闭未确认，不重复关闭')
      const button = await page.locator('[data-shortcut-modal="settings"]')
        .getByRole('button', { name: /^(Close|关闭)$/ }).elementHandle({ timeout: remaining() })
      requireThat(button !== null, '未找到本轮设置面板的关闭按钮')
      try {
        requireThat(await element.evaluate((panel, target) => panel.contains(target), button), '设置面板已变化，未关闭其他面板')
        owned.closeAttempted = true
        await button.click({ timeout: remaining() })
      } finally { await button.dispose() }
      await element.waitForElementState('hidden', { timeout: remaining() })
    }
    await element.dispose()
    owned = undefined
  }
  return {
    async open() {
      requireThat(openingPage === undefined, '本轮设置面板打开结果未确认')
      if (owned?.closeAttempted) await close()
      const page = getPage(), modal = page.locator('[data-shortcut-modal="settings"]')
      requireThat(owned === undefined || owned.page === page && !page.isClosed(), '本轮设置面板所属页面已变化或失联')
      if (!await modal.isVisible()) {
        await close()
        await page.getByRole('button', { name: /^(Account:|账号[：:])/ }).click({ timeout: remaining() })
        openingPage = page
        await page.getByRole('menuitem', { name: /^(Settings|设置)$/ }).click({ timeout: remaining() })
        const element = await modal.elementHandle({ timeout: remaining() })
        requireThat(element !== null, '本轮设置面板打开结果未确认')
        owned = { page, element, closeAttempted: false }
        openingPage = undefined
      }
      await modal.waitFor({ state: 'visible', timeout: remaining() })
      return modal
    },
    close,
  }
}

/** Use the original Settings form and runner's login/chat/command actions.
 * @param input Current browser and existing account/conversation actions with their remaining budget.
 * @returns Checks owning one keyless service and, after save, one unique account connection.
 */
export async function createBrowserMcpChecks({ getPage, signOut, signIn, newConversation, send, command, remaining, host }) {
  const serverName = `smoke_${randomBytes(6).toString('hex')}`
  let saveAttempted = false
  let page = getPage()
  let section = page.getByRole('region', { name: title })
  const settings = createMcpSettingsNavigation(getPage, remaining)

  async function phase(name, action) {
    const started = Date.now()
    try {
      // The original runner can replace a closed page while joining a failed step.
      const current = getPage()
      if (current !== page) {
        page = current
        section = page.getByRole('region', { name: title })
      }
      try { console.warn('MCP smoke phase: %j', { phase: name, state: 'begin' }) } catch (_diagnosticFailure) {}
      const value = await action()
      try { console.warn('MCP smoke phase: %j', { phase: name, state: 'end', elapsedMs: Date.now() - started }) } catch (_diagnosticFailure) {}
      return value
    } catch (error) { throw new McpSmokeFailure(`MCP 检查未完成：${name}`, { cause: error }) }
  }
  async function open() {
    const modal = await settings.open()
    await modal.getByRole('button', { name: title }).click({ timeout: remaining() })
    await section.waitFor({ state: 'visible', timeout: remaining() })
  }
  async function closeSettings() {
    await settings.close()
  }
  function row(name) {
    // Names come only from this run's fixed smoke_ prefix and random hex.
    return section.locator('article').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${name}$`) }) })
  }
  async function ownRow(name) {
    const selected = row(name)
    requireThat(await selected.count() === 1, '未唯一找到本轮 MCP 连接')
    requireThat((await selected.locator('strong').allTextContents()).join('') === name, 'MCP 连接名称与本轮不一致')
    return selected
  }
  async function operation(button) {
    const response = page.waitForResponse(value => value.request().method() === 'POST'
      && new URL(value.url()).pathname.endsWith('/cloudMcpConnections/action'), { timeout: remaining() })
    void response.catch((_observerFailure) => {})
    await button.click()
    const value = await response
    requireThat(value.ok() && await value.finished() === null, 'MCP 操作响应未确认')
    // Await the form's request owner releasing busy after applying this reply.
    await section.locator('button:enabled').filter({ hasText: /^(Refresh|刷新)$/ }).waitFor({ state: 'visible' })
  }
  async function probe(form) {
    await operation(form.getByRole('button', { name: label.test }))
    const status = form.getByRole('status').filter({ hasText: label.success })
    await status.waitFor({ state: 'visible', timeout: remaining() })
    const count = toolCount(await status.innerText())
    reportCount('probe-discovery', count)
    return count
  }
  function toolCount(text) {
    const match = text.match(/(\d+) discovered tools|已发现\s*(\d+)\s*个工具/)
    requireThat(match !== null, '无法读取本轮 MCP 工具数量')
    return Number(match[1] ?? match[2])
  }
  function reportCount(kind, count) {
    try { console.warn('MCP smoke count: %j', { kind, count }) } catch (_diagnosticFailure) {}
  }
  async function registrationCount(name) {
    await operation(section.getByRole('button', { name: /^(Refresh|刷新)$/ }))
    const selected = await ownRow(name)
    requireThat(await selected.locator('p').first().innerText() === fixture.url, '本轮 MCP 连接地址已变化')
    await selected.getByText(/^(Enabled|已启用)$/).waitFor({ state: 'visible', timeout: remaining() })
    const count = toolCount(await selected.innerText())
    reportCount('account-registration', count)
    return count
  }
  const actions = {
    add: (name, url) => phase('添加本轮连接', async () => {
      await open()
      requireThat(await row(name).count() === 0, '本轮 MCP 连接名称已存在')
      const form = section.locator('form')
      await form.getByLabel(label.name).fill(name)
      await form.getByLabel(label.url).fill(url)
      // Prove cloud-to-fixture reachability before saving any connection.
      const probeToolCount = await probe(form)
      requireThat(probeToolCount > 0, '本轮 MCP 连通测试未发现工具')
      saveAttempted = true
      await operation(form.getByRole('button', { name: /^(Save|保存)$/ }))
      await row(name).waitFor({ state: 'visible' })
      await ownRow(name)
      await closeSettings()
      return probeToolCount
    }),
    registrationCount: (name, signal) => phase('读取本轮恢复前注册数', async () => {
      signal.throwIfAborted()
      await open()
      const count = await registrationCount(name)
      signal.throwIfAborted()
      await closeSettings()
      return count
    }),
    waitRegistered: (name, accepts, signal) => phase('观察账号已注册工具数', async () => {
      await open()
      for (;;) {
        signal.throwIfAborted()
        const count = await registrationCount(name)
        if (accepts(count)) { await closeSettings(); return count }
        // Pace foreground list reads; success depends on observed registered state.
        await page.waitForTimeout(Math.min(500, remaining()))
      }
    }),
    testOnce: name => phase('对原连接测试一次', async () => {
      await open()
      const selected = await ownRow(name)
      await selected.getByText(/^(Enabled|已启用)$/).waitFor({ state: 'visible' })
      await selected.getByRole('button', { name: /^(Edit|编辑)$/ }).click()
      const form = section.locator('form')
      requireThat(await form.getByLabel(label.name).inputValue() === name, '测试表单没有指向本轮连接')
      requireThat(await form.getByLabel(label.url).inputValue() === fixture.url, '测试表单地址与本轮不一致')
      const probeToolCount = await probe(form)
      await closeSettings()
      return probeToolCount
    }),
    invoke: (tool, marker) => phase('实际调用本轮 MCP 工具', async () => {
      await closeSettings()
      await send(`Call only ${tool} exactly once and report its exact returned text.`, { tools: [tool], tokens: [marker] })
    }),
    signOut: () => phase('正常退出登录', signOut),
    signIn: () => phase('正常重新登录', signIn),
    newConversation: () => phase('打开新对话', newConversation),
    command: () => phase('在新对话执行命令', command),
    cleanupConnection: authenticated => phase('移除本轮唯一连接', async () => {
      const result = await removeMcpSmokeConnection({
        saveAttempted, authenticated, name: serverName, url: fixture.url,
        find: async () => {
          await open()
          await operation(section.getByRole('button', { name: /^(Refresh|刷新)$/ }))
          const candidates = row(serverName), values = []
          for (let index = 0; index < await candidates.count(); index++) {
            const selected = candidates.nth(index)
            values.push({ name: (await selected.locator('strong').allTextContents()).join(''),
              url: await selected.locator('p').first().innerText() })
          }
          return values
        },
        remove: async () => {
          const selected = await ownRow(serverName)
          requireThat(await selected.locator('p').first().innerText() === fixture.url,
            '本轮 MCP 连接地址已变化，未执行移除')
          await selected.getByRole('button', { name: /^(Remove|移除)$/ }).click()
          await operation(selected.getByRole('button', { name: /^(Confirm removal|确认移除)$/ }))
          await row(serverName).waitFor({ state: 'hidden' })
        },
      })
      saveAttempted = false
      await closeSettings()
      return result
    }),
  }
  // No asynchronous setup follows acquisition before the caller owns cleanup.
  const fixture = await createMcpSmokeFixture({ host })
  const connection = Object.freeze({ serverName, url: fixture.url })
  try { console.warn('MCP smoke owned connection: %j', connection) } catch (_diagnosticFailure) {}
  return { ...mcpChecks(fixture, actions, serverName), connection }
}
