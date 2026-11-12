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
 * @param fixture This run's service and actual invocation observations.
 * @param actions Browser actions owned by the original smoke runner.
 * @param serverName Unique connection name created by this run.
 * @returns Finite outage/recovery operations and owned connection/service cleanup.
 */
export function mcpChecks(fixture, actions, serverName) {
  const tool = `mcp__${serverName}__ping`
  let offlineAttempted = false, offlineComplete = false, recoveryAttempted = false
  async function invoke() {
    const before = fixture.calls.length
    await actions.invoke(tool, fixture.marker)
    requireThat(fixture.calls.length === before + 1, '未确认本轮 MCP 工具实际执行一次')
  }
  return {
    async offline(signal) {
      requireThat(!offlineAttempted, 'MCP 掉线检查不能重复执行')
      offlineAttempted = true
      signal.throwIfAborted()
      await actions.add(serverName, fixture.url)
      await actions.waitRegistered(serverName, count => count > 0, signal)
      signal.throwIfAborted()
      await invoke()
      await fixture.stop()
      requireThat(fixture.state === 'stopped', 'MCP 服务停止未确认')
      signal.throwIfAborted()
      await actions.signOut()
      await actions.signIn()
      await actions.newConversation()
      await actions.command()
      offlineComplete = true
    },
    async recover(signal) {
      requireThat(offlineComplete && !recoveryAttempted && fixture.state === 'stopped', 'MCP 恢复检查缺少同轮掉线前态')
      recoveryAttempted = true
      await actions.waitRegistered(serverName, count => count === 0, signal)
      signal.throwIfAborted()
      await fixture.restart()
      signal.throwIfAborted()
      await actions.testOnce(serverName)
      await actions.waitRegistered(serverName, count => count > 0, signal)
      signal.throwIfAborted()
      await actions.newConversation()
      await invoke()
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

/** Use the original Settings form and runner's login/chat/command actions.
 * @param input Current browser and existing account/conversation actions with their remaining budget.
 * @returns Checks owning one keyless service and, after save, one unique account connection.
 */
export async function createBrowserMcpChecks({ getPage, signOut, signIn, newConversation, send, command, remaining }) {
  const serverName = `smoke_${randomBytes(6).toString('hex')}`
  let saveAttempted = false
  let page = getPage()
  let modal = page.locator('[data-shortcut-modal="settings"]')
  let section = page.getByRole('region', { name: title })

  async function phase(name, action) {
    const started = Date.now()
    try {
      // The original runner can replace a closed page while joining a failed step.
      const current = getPage()
      if (current !== page) {
        page = current
        modal = page.locator('[data-shortcut-modal="settings"]')
        section = page.getByRole('region', { name: title })
      }
      try { console.warn('MCP smoke phase: %j', { phase: name, state: 'begin' }) } catch (_diagnosticFailure) {}
      const value = await action()
      try { console.warn('MCP smoke phase: %j', { phase: name, state: 'end', elapsedMs: Date.now() - started }) } catch (_diagnosticFailure) {}
      return value
    } catch (error) { throw new McpSmokeFailure(`MCP 检查未完成：${name}`, { cause: error }) }
  }
  async function open() {
    if (!await modal.isVisible()) await page.getByRole('button', { name: /^(Settings|设置)$/ }).click()
    await modal.getByRole('button', { name: title }).click()
    await section.waitFor({ state: 'visible' })
  }
  async function closeSettings() {
    if (await modal.isVisible()) { await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' }) }
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
    await form.getByRole('status').filter({ hasText: label.success }).waitFor({ state: 'visible' })
  }
  const actions = {
    add: (name, url) => phase('添加本轮连接', async () => {
      await open()
      requireThat(await row(name).count() === 0, '本轮 MCP 连接名称已存在')
      const form = section.locator('form')
      await form.getByLabel(label.name).fill(name)
      await form.getByLabel(label.url).fill(url)
      // Prove cloud-to-fixture reachability before saving any connection.
      await probe(form)
      saveAttempted = true
      await operation(form.getByRole('button', { name: /^(Save|保存)$/ }))
      await row(name).waitFor({ state: 'visible' })
      await ownRow(name)
      await closeSettings()
    }),
    waitRegistered: (name, accepts, signal) => phase('观察账号已注册工具数', async () => {
      await open()
      for (;;) {
        signal.throwIfAborted()
        await operation(section.getByRole('button', { name: /^(Refresh|刷新)$/ }))
        const selected = await ownRow(name)
        const match = (await selected.innerText()).match(/(\d+) discovered tools|已发现\s*(\d+)\s*个工具/)
        requireThat(match !== null, '无法读取本轮 MCP 连接的工具数')
        const count = Number(match[1] ?? match[2])
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
      await probe(form)
      await closeSettings()
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
      if (result !== 'not-added') await closeSettings()
      return result
    }),
  }
  // No asynchronous setup follows acquisition before the caller owns cleanup.
  const fixture = await createMcpSmokeFixture()
  const connection = Object.freeze({ serverName, url: fixture.url })
  try { console.warn('MCP smoke owned connection: %j', connection) } catch (_diagnosticFailure) {}
  return { ...mcpChecks(fixture, actions, serverName), connection }
}
