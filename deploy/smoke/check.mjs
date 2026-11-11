#!/usr/bin/env node
/** Exercise the installed Cloud UI with a disposable browser and one designated test account. */
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { readOptions } from './options.mjs'
import { createBudget, readDownload, StepTimeout, stopPendingTurn, waitForPreviousReply, withStepDeadline } from './steps.mjs'

const help = `用法：node deploy/smoke/check.mjs [--url 网页入口] [--credentials 私密JSON] [--account 账号字段]
也可通过 PE_CLOUD_SMOKE_EMAIL 和 PE_CLOUD_SMOKE_PASSWORD 提供测试账号。
默认检查本机 http://127.0.0.1:32802，JSON 默认账号字段为 ordinaryUserC。
--wrong-password 使用随机错误口令验证失败报告；预期退出码非 0。
--continue-session 与 --continue-marker 成对提供，检查更新前的对话历史及继续执行命令。
--mcp、--research 尚未实现，显式请求时报告未做并以非 0 退出。
检查会创建一个对话及三个随机命名的小文件，保留它们供复核。
所有必选项通过且总用时不超过五分钟时退出 0；失败或未验证时退出 1。`

class SmokeFailure extends Error {}
class SmokeUnavailable extends Error {}

async function run(options) {
  const started = Date.now()
  const numbers = options.continueSession === undefined ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 2, 12, 3, 4, 5, 6, 7, 8, 9]
  const budget = createBudget(5 * 60 * 1000, numbers)
  const deadline = budget.deadline
  let phaseDeadline = deadline
  const remaining = () => Math.max(1, Math.min(deadline, phaseDeadline) - Date.now())
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true, timeout: budget.startupMs })
  let authenticated = false
  let loginMayBeActive = false
  let signOutAttempted = false
  let exitCode = 1
  let page
  let closeLogin
  let closePage
  let restorePage
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
    const prefix = `pe-smoke-${randomBytes(6).toString('hex')}`
    const searchFile = `${prefix}-search.txt`
    const uploadFile = `${prefix}-upload.txt`
    const previewFile = `${prefix}-preview.md`
    const searchToken = `${prefix}-SEARCH`
    const uploadToken = `${prefix}-UPLOAD`
    const previewToken = `${prefix}-PREVIEW`
    const outcomes = new Map()
    const requiredChecks = options.continueSession === undefined ? 9 : 10
    let sessionKey
    let currentSessionKey
    let pendingTurn
    let conversationReady = true
    let activeNumber
    const observers = new Set()
    let bootstrapStatus = null
    const isBootstrap = response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/cloud/bootstrap'
    const attachPage = target => target.on('response', response => { if (isBootstrap(response)) bootstrapStatus = response.status() })
    attachPage(page)
    console.log(`本轮标识：${prefix}`)

    function requireThat(condition, message) {
      if (!condition) throw new SmokeFailure(message)
    }

    function observe(promise) {
      observers.add(promise)
      void promise.then(() => observers.delete(promise), () => observers.delete(promise))
      return promise
    }

    closePage = async () => {
      try { if (page !== undefined && !page.isClosed()) await page.close({ runBeforeUnload: false }) }
      finally { await Promise.allSettled([...observers]) }
    }

    restorePage = async () => {
      if (page === undefined || page.isClosed()) { page = await context.newPage(); attachPage(page) }
      page.setDefaultTimeout(remaining())
      page.setDefaultNavigationTimeout(remaining())
      await page.goto(options.url, { timeout: remaining() })
    }

    async function recoverStep() {
      await restorePage()
      const key = pendingTurn?.sessionKey ?? currentSessionKey
      if (pendingTurn) {
        conversationReady = false
        requireThat(key, '未找到需要停止的对话，无法确认本项收尾')
        await openPreviousSession(key)
        await stopPendingTurn(page, pendingTurn.before, remaining())
        pendingTurn = undefined
        conversationReady = true
      } else if (authenticated && key) await openPreviousSession(key)
    }

    async function check(number, label, action, dependencies = []) {
      const allowance = budget.step(number)
      if (dependencies.some(id => outcomes.get(id) !== 'pass') || Date.now() >= deadline
        || [4, 5, 6, 7, 8].includes(number) && (!sessionKey || !conversationReady)) {
        outcomes.set(number, 'skip')
        console.log(`未验证 ${number}. ${label}：前置条件或原对话收尾未确认`)
        return
      }
      activeNumber = number
      phaseDeadline = Date.now() + allowance.workMs
      const stepStarted = Date.now()
      try {
        const detail = await withStepDeadline(async signal => {
          if (page.isClosed()) await restorePage()
          page.setDefaultTimeout(remaining())
          page.setDefaultNavigationTimeout(remaining())
          return action(signal)
        }, { timeoutMs: remaining(), cancel: closePage })
        outcomes.set(number, 'pass')
        console.log(`通过 ${number}. ${label}（${((Date.now() - stepStarted) / 1000).toFixed(1)}秒）${detail ? `：${detail}` : ''}`)
      } catch (error) {
        outcomes.set(number, error instanceof SmokeUnavailable ? 'skip' : 'fail')
        // Playwright error messages can contain form values. Only our fixed diagnostics are printed.
        const message = error instanceof StepTimeout || error?.name === 'TimeoutError' ? '本项检查超时'
          : error instanceof SmokeFailure || error instanceof SmokeUnavailable ? error.message : '网页操作未完成'
        console.log(`${error instanceof SmokeUnavailable ? '未验证' : '失败'} ${number}. ${label}：${message}`)
        console.log(`页面诊断：${JSON.stringify({ bootstrapStatus })}`)
        phaseDeadline = allowance.deadline
        try { await withStepDeadline(recoverStep, { timeoutMs: remaining(), cancel: closePage }) }
        catch (_recoveryError) {
          if (pendingTurn) conversationReady = false
          console.log('收尾：当前对话未确认可继续，独立检查仍会运行')
        }
      }
    }

    async function login() {
      requireThat(!authenticated && !loginMayBeActive, '上一次登录尚未确认退出，不再新增登录')
      await page.locator('input[type="email"]').waitFor({ state: 'visible' })
      await page.locator('input[type="email"]').fill(options.email)
      await page.locator('input[type="password"]').fill(options.password)
      const nextBootstrap = observe(page.waitForResponse(isBootstrap, { timeout: remaining() }))
      // A rejected login has no follow-up bootstrap; browser disposal ends this observer.
      void nextBootstrap.catch((_error) => { /* The accepted-login path awaits the original promise. */ })
      loginMayBeActive = true
      const [result] = await Promise.all([
        observe(page.waitForResponse(res => res.request().method() === 'POST'
          && res.url().includes('/sign-in/email'), { timeout: remaining() })),
        page.locator('button[type="submit"]').click(),
      ])
      if (!result.ok()) loginMayBeActive = false
      requireThat(result.ok(), `登录请求被拒绝（HTTP ${result.status()}），请核对测试账号和口令`)
      requireThat(await result.finished() === null, '登录响应未完整结束，登录结果未确认')
      authenticated = true
      signOutAttempted = false
      const bootstrap = await nextBootstrap
      if (bootstrap.status() !== 200) {
        let code
        try {
          const failure = await bootstrap.json()
          if (typeof failure?.code === 'string' && /^cloud\/[a-z0-9-]+$/.test(failure.code)) code = failure.code
        } catch (_invalidBody) { /* Non-JSON and arbitrary response bodies are never printed. */ }
        throw new SmokeFailure(`登录后 bootstrap 返回 HTTP ${bootstrap.status()}${code ? `（${code}）` : ''}，预期 200`)
      }
      await page.waitForFunction(() => document.getElementById('root')?.parentElement?.dataset.state === 'running',
        undefined, { timeout: remaining() })
      await page.getByRole('button', { name: /^(New session|新建会话|新建对话)$/i }).last().waitFor({ state: 'visible' })
    }

    async function send(prompt, { tokens = [], bash = 0, tools = [] } = {}) {
      if (pendingTurn && !conversationReady) throw new SmokeUnavailable('上一轮对话收尾未确认，本项未发送')
      const before = await page.locator('[data-turn-process]').evaluateAll(elements => elements.map(e => e.dataset.turnProcess))
      await page.locator('[data-composer-input][contenteditable="true"]').fill(`${prompt}\nIf any tool call fails, do not retry it and do not use another tool as a substitute. Report the original failure and end this turn immediately.`)
      pendingTurn = { before, sessionKey: currentSessionKey }
      await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
      currentSessionKey = await page.locator('[data-row-key^="session:"][aria-selected="true"]').getAttribute('data-row-key')
      pendingTurn.sessionKey = currentSessionKey
      if (activeNumber === 3) sessionKey = currentSessionKey
      const handle = await page.waitForFunction(old => {
        const turns = [...document.querySelectorAll('[data-turn-process]')]
        return turns.find(e => !old.includes(e.getAttribute('data-turn-process')))?.getAttribute('data-turn-process') ?? false
      }, before, { timeout: remaining() })
      const turn = await handle.jsonValue()
      await handle.dispose()
      pendingTurn = undefined
      conversationReady = true
      const processButton = page.locator(`[data-turn-process="${turn}"]`)
      const nodes = page.locator(`[data-chat-turn="${turn}"]`)
      if (await processButton.getAttribute('aria-expanded') === 'false') await processButton.click()
      const cards = nodes.locator('[data-chat-call-id] [data-state][data-variant], [data-chat-call-id] [data-state][data-tool]')
      const states = await cards.evaluateAll(elements => elements.map(e => ({
        variant: e.dataset.variant ?? null, tool: e.dataset.tool ?? null, state: e.dataset.state ?? null,
      })))
      const failed = states.filter(row => row.state !== 'ok')
      const knownErrors = [
        'grep subprocess failed before reporting an outcome',
        'Cloud execution is not confirmed available; Root retains cleanup responsibility.',
      ]
      const turnText = (await nodes.allTextContents()).join('\n')
      const diagnostics = knownErrors.filter(message => turnText.includes(message))
      requireThat(failed.length === 0, `本轮存在未成功的工具调用：${JSON.stringify(failed)}${diagnostics.length ? `；${diagnostics.join('；')}` : ''}`)
      requireThat(!/Failed|失败|Stopped|已停止/i.test(await processButton.innerText()), '对话轮次以失败或停止结束')
      if (bash) requireThat(states.filter(row => row.variant === 'bash' && row.state === 'ok').length >= bash,
        `本轮成功的独立命令调用不足 ${bash} 次`)
      for (const tool of tools) requireThat(states.some(row => row.tool === tool && row.state === 'ok'),
        `未观察到成功的 ${tool} 工具调用`)
      // The response group belongs to the node itself; keep reasoning and user prompts out of assertions.
      const answer = await page.locator(`[data-chat-turn="${turn}"][data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]`).allTextContents()
      for (const token of tokens) requireThat(answer.join('\n').includes(token), '模型最终回复没有包含本项预期结果')
      return turn
    }

    async function signOut() {
      requireThat(!signOutAttempted, '退出未确认')
      signOutAttempted = true
      const response = observe(page.waitForResponse(res => res.request().method() === 'POST'
        && new URL(res.url()).pathname === '/cloud/auth/sign-out', { timeout: remaining() }))
      // A disabled or unavailable UI may never submit; browser disposal ends the observer.
      void response.catch((_error) => { /* The submitted-logout path awaits the original promise. */ })
      const shellState = await page.evaluate(() => document.getElementById('root')?.parentElement?.dataset.state)
      if (shellState === 'running') {
        await page.getByRole('button', { name: /^(Account:|账号[：:])/ }).click()
        await page.getByRole('menuitem', { name: /^(Sign out|退出登录)$/ }).click()
      } else {
        // CloudWebEntry exposes its normal sign-out button when the native page is unavailable.
        await page.getByRole('button', { name: /^(Sign out|退出登录)$/ }).click()
      }
      const result = await response
      requireThat(result.ok() && await result.finished() === null, '退出未确认')
      authenticated = false
      loginMayBeActive = false
      pendingTurn = undefined
      conversationReady = true
      await page.locator('input[type="email"]').waitFor({ state: 'visible' })
    }
    closeLogin = signOut

    async function openPreviousSession(key) {
      const row = page.locator(`[data-row-key="${key}"]`)
      await page.locator('[data-row-key^="session:"]').first().waitFor({ state: 'attached' })
      while (await row.count() === 0) {
        const more = page.getByRole('button', { name: /^(Show \d+ more sessions|展开其余 \d+ 个会话)$/ })
        requireThat(await more.count() !== 0, '侧栏没有找到指定的更新前对话')
        const previous = await page.locator('[data-row-key^="session:"]').count()
        await more.first().click()
        await page.waitForFunction(({ previous, key }) => {
          const rows = [...document.querySelectorAll('[data-row-key^="session:"]')]
          return rows.length > previous || rows.some(element => element.getAttribute('data-row-key') === key)
        }, { previous, key }, { timeout: remaining() })
      }
      await row.click()
      const session = key.slice('session:'.length)
      const content = page.locator(`[data-conversation-content][data-conversation-session="${session}"][data-content-phase="active"]`)
      await content.waitFor({ state: 'visible' })
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ state: 'visible' })
      currentSessionKey = key
      return content
    }

    await check(1, '首页和未登录入口', async () => {
      const home = await page.goto(options.url, { timeout: remaining() })
      requireThat(home?.status() === 200, `首页返回 HTTP ${home?.status() ?? '无响应'}`)
      const bootstrap = await context.request.get(`${options.url}/cloud/bootstrap`, { timeout: remaining() })
      requireThat(bootstrap.status() === 401, `未登录 bootstrap 返回 HTTP ${bootstrap.status()}，预期 401`)
      return '首页 200，bootstrap 401'
    })
    await check(2, '测试账号登录', async () => { await login(); return '登录后 bootstrap 200' }, [1])
    if (options.continueSession !== undefined) {
      await check(12, '更新前对话保留并能继续执行命令', async () => {
        const content = await openPreviousSession(options.continueSession)
        await waitForPreviousReply(content, options.continueMarker, remaining())
        const token = `${prefix}-CONTINUE`
        await send(`Use Bash to execute printf '%s\\\\n' '${token}'. Report actual stdout.`, { tokens: [token], bash: 1 })
        return '原回复标记保留，新的命令调用和回复通过'
      }, [2])
    }
    await check(3, '新建对话并获得模型回复', async () => {
      await page.getByRole('button', { name: /^(New session|新建会话|新建对话)$/i }).last().click()
      currentSessionKey = undefined
      await page.locator('[data-conversation-content][data-content-phase="hero"]').waitFor({ state: 'visible' })
      const chooseWorkspace = page.getByRole('button', { name: /^(Choose workspace|选择工作区)$/ })
      if (await chooseWorkspace.isVisible()) {
        await chooseWorkspace.click()
        await page.getByRole('menuitem', { name: /^(Default workspace|默认工作区)$/ }).click()
      }
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ state: 'visible' })
      const token = `${prefix}-CHAT`
      await send(`Reply with exactly ${token}. Do not use tools.`, { tokens: [token] })
      sessionKey = await page.locator('[data-row-key^="session:"][aria-selected="true"]').getAttribute('data-row-key')
      requireThat(sessionKey, '未找到新建对话的侧栏记录')
      console.log(`本轮对话：${sessionKey}`)
    }, [2])
    await check(4, '沙箱执行一条命令', async () => {
      const token = `${prefix}-EXEC`
      await send(`Use Bash to execute exactly: printf '%s\\n' '${token}'. Report its actual stdout.`, { tokens: [token], bash: 1 })
    }, [2])
    await check(5, '同一对话连续执行五条命令', async () => {
      const tokens = [1, 2, 3, 4, 5].map(n => `${prefix}-SEQ-${n}`)
      const commands = tokens.map(token => `printf '%s\\n' '${token}'`).join('; then ')
      await send(`Make exactly five separate sequential Bash tool calls, one per command. Do not combine commands into one call. Execute in order: ${commands}. Report all five actual stdout lines.`, { tokens, bash: 5 })
      return '五次独立命令成功，覆盖每四条命令更换沙箱的路径'
    }, [2])
    await check(6, '按文件名和内容搜索', async () => {
      await send(`Use Bash to create ${searchFile} in the current workspace with exactly '${searchToken}' as its content. Then use the file-name search tool (glob) to find ${searchFile}, and the file-content search tool (grep) to find '${searchToken}' in it. Do not replace either search with shell commands. Report the actual matching filename and content.`,
        { tokens: [searchFile, searchToken], bash: 1, tools: ['glob', 'grep'] })
    }, [2])
    await check(7, '上传并读取文本文件', async () => {
      await page.getByRole('button', { name: /^(Add files or run commands|添加文件或运行命令)$/ }).click()
      await page.locator('input[type="file"]').setInputFiles({ name: uploadFile, mimeType: 'text/plain', buffer: Buffer.from(uploadToken) })
      await page.keyboard.press('Escape')
      // The random content is in the attachment only, never in the model prompt.
      await send(`Read the attached file ${uploadFile} and reply with its full exact content.`, { tokens: [uploadToken] })
    }, [2])
    await check(8, '生成文件、预览和下载', async signal => {
      await send(`Use Bash to create ${previewFile} in the current workspace with exactly '${previewToken}' followed by a newline. Then report the filename.`, { tokens: [previewFile], bash: 1 })
      const expand = page.locator('[data-sidebar-right-expand]')
      if (await expand.isVisible()) await expand.click()
      const column = page.locator('[data-rightbar-col]')
      const guide = column.locator('[data-sidebar-right-guide-entry="files"]')
      if (await guide.isVisible()) await guide.click()
      else await column.getByRole('tab', { name: /^(Files|文件)$/ }).click()
      await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
      await column.locator('[data-files-entry="file"]').getByRole('button', { name: previewFile, exact: true }).click()
      const preview = page.locator('[data-textpreview-state="text"][data-textpreview-url]').filter({ hasText: previewToken })
      await preview.waitFor({ state: 'visible' })
      requireThat((await preview.getAttribute('data-textpreview-url'))?.endsWith(`/${previewFile}`), '预览打开的文件与本轮生成文件不一致')
      const [content] = await Promise.all([
        observe(page.waitForEvent('download', { timeout: remaining() }).then(download => readDownload(download, signal))),
        preview.getByRole('button', { name: /^(Download|下载)$/ }).click(),
      ])
      requireThat(content.toString('utf8') === `${previewToken}\n`, '下载内容与本轮指定内容不一致')
    }, [2])
    await check(9, '重新登录后继续原对话执行命令', async () => {
      const originalConversationReady = conversationReady
      if (page.isClosed()) await restorePage()
      signOutAttempted = false
      await signOut()
      await login()
      if (!sessionKey) throw new SmokeUnavailable('尚未建立可复核的原对话；退出重登已完成')
      if (!originalConversationReady) throw new SmokeUnavailable('原对话收尾未确认；退出重登已完成，继续执行未验证')
      await page.locator(`[data-row-key="${sessionKey}"]`).click()
      await page.locator('[data-turn-process]').first().waitFor({ state: 'attached' })
      requireThat((await page.locator('[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]').allTextContents()).join('\n').includes(`${prefix}-CHAT`), '重新登录后没有找到原对话内容')
      const token = `${prefix}-RELOGIN`
      await send(`Use Bash to execute printf '%s\\n' '${token}'. Report actual stdout.`, { tokens: [token], bash: 1 })
    }, [2])
    console.log('未做 10. MCP 检查；未做 11. 科研模式检查：留待对应迭代扩展')
    const passed = [...outcomes.values()].filter(value => value === 'pass').length
    const failed = [...outcomes.values()].filter(value => value === 'fail').length
    const skipped = [...outcomes.values()].filter(value => value === 'skip').length
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`合计：通过 ${passed}/${requiredChecks}，失败 ${failed}，未验证 ${skipped}，用时 ${elapsed}秒`)
    exitCode = passed === requiredChecks && Date.now() <= deadline && !options.mcp && !options.research ? 0 : 1
  } finally {
    if (authenticated || loginMayBeActive) {
      if (Date.now() < deadline && browser.isConnected() && closeLogin !== undefined) {
        try {
          phaseDeadline = deadline
          signOutAttempted = false
          await withStepDeadline(async () => {
            if (page === undefined || page.isClosed()) await restorePage()
            page.setDefaultTimeout(remaining())
            page.setDefaultNavigationTimeout(remaining())
            await closeLogin()
          }, { timeoutMs: remaining(), cancel: closePage })
          console.log('清理：测试账号已正常退出')
        } catch (_cleanupError) {
          exitCode = 1
          console.error('退出未确认；本轮以失败退出')
        }
      } else {
        exitCode = 1
        console.error('退出未确认；本轮以失败退出')
      }
    }
    try { await browser.close() }
    catch (_browserCloseError) {
      exitCode = 1
      console.error('浏览器关闭未确认；本轮以失败退出')
    }
  }
  console.log(`总用时（含退出）：${((Date.now() - started) / 1000).toFixed(1)}秒`)
  return Date.now() <= deadline ? exitCode : 1
}

try {
  const options = await readOptions()
  if (options.help) console.log(help)
  else process.exitCode = await run(options)
} catch (_error) {
  // Never print exception payloads: browser and credential loaders may retain secret input.
  console.error('失败：检查无法启动；请核对参数、0600 凭据文件、Node 24 依赖和浏览器安装。使用 --help 查看用法。')
  process.exitCode = 1
}
