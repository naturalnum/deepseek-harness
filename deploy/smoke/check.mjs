#!/usr/bin/env node
/** Exercise the installed Cloud UI with a disposable browser and one designated test account. */
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { readOptions } from './options.mjs'

const help = `用法：node deploy/smoke/check.mjs [--url 网页入口] [--credentials 私密JSON] [--account 账号字段]
也可通过 PE_CLOUD_SMOKE_EMAIL 和 PE_CLOUD_SMOKE_PASSWORD 提供测试账号。
默认检查本机 http://127.0.0.1:32802，JSON 默认账号字段为 ordinaryUserC。
--wrong-password 使用随机错误口令验证失败报告；预期退出码非 0。
--mcp、--research 尚未实现，显式请求时报告未做并以非 0 退出。
检查会创建一个对话及三个随机命名的小文件，保留它们供复核。
所有必选项通过且总用时不超过五分钟时退出 0；失败或未验证时退出 1。`

class SmokeFailure extends Error {}

async function run(options) {
  const started = Date.now()
  const deadline = started + 5 * 60 * 1000
  const remaining = () => Math.max(1, deadline - Date.now())
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true, timeout: remaining() })
  const timer = setTimeout(() => { void browser.close().catch((_error) => { /* The joined close below reports cleanup failure. */ }) }, remaining())
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const prefix = `pe-smoke-${randomBytes(6).toString('hex')}`
    const searchFile = `${prefix}-search.txt`
    const uploadFile = `${prefix}-upload.txt`
    const previewFile = `${prefix}-preview.md`
    const searchToken = `${prefix}-SEARCH`
    const uploadToken = `${prefix}-UPLOAD`
    const previewToken = `${prefix}-PREVIEW`
    const outcomes = new Map()
    let sessionKey
    console.log(`本轮标识：${prefix}`)

    function requireThat(condition, message) {
      if (!condition) throw new SmokeFailure(message)
    }

    async function check(number, label, action, dependencies = []) {
      if (dependencies.some(id => outcomes.get(id) !== 'pass') || Date.now() >= deadline) {
        outcomes.set(number, 'skip')
        console.log(`未验证 ${number}. ${label}：前置检查未通过或五分钟已用尽`)
        return
      }
      page.setDefaultTimeout(remaining())
      page.setDefaultNavigationTimeout(remaining())
      const stepStarted = Date.now()
      try {
        const detail = await action()
        outcomes.set(number, 'pass')
        console.log(`通过 ${number}. ${label}（${((Date.now() - stepStarted) / 1000).toFixed(1)}秒）${detail ? `：${detail}` : ''}`)
      } catch (error) {
        outcomes.set(number, 'fail')
        // Playwright error messages can contain form values. Only our fixed diagnostics are printed.
        const message = error instanceof SmokeFailure ? error.message : '网页操作未完成或超时'
        console.log(`失败 ${number}. ${label}：${message}`)
      }
    }

    async function login() {
      await page.locator('input[type="email"]').waitFor({ state: 'visible' })
      await page.locator('input[type="email"]').fill(options.email)
      await page.locator('input[type="password"]').fill(options.password)
      const [result] = await Promise.all([
        page.waitForResponse(res => res.request().method() === 'POST'
          && res.url().includes('/sign-in/email'), { timeout: remaining() }),
        page.locator('button[type="submit"]').click(),
      ])
      requireThat(result.ok(), `登录请求被拒绝（HTTP ${result.status()}），请核对测试账号和口令`)
      await page.locator('[data-composer-input]').waitFor({ state: 'visible' })
      const bootstrap = await context.request.get(`${options.url}/cloud/bootstrap`, { timeout: remaining() })
      requireThat(bootstrap.status() === 200, `登录后 bootstrap 返回 HTTP ${bootstrap.status()}，预期 200`)
    }

    async function send(prompt, { tokens = [], bash = 0, bashTokens = [], tools = [] } = {}) {
      const before = await page.locator('[data-turn-process]').evaluateAll(elements => elements.map(e => e.dataset.turnProcess))
      await page.locator('[data-composer-input][contenteditable="true"]').fill(`${prompt}\nIf any tool call fails, do not retry it and do not use another tool as a substitute. Report the original failure and end this turn immediately.`)
      await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
      const handle = await page.waitForFunction(old => {
        const turns = [...document.querySelectorAll('[data-turn-process]')]
        return turns.find(e => !old.includes(e.getAttribute('data-turn-process')))?.getAttribute('data-turn-process') ?? false
      }, before, { timeout: remaining() })
      const turn = await handle.jsonValue()
      await handle.dispose()
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
      if (bashTokens.length) {
        const outputs = []
        const calls = nodes.locator('[data-chat-call-id]').filter({ has: page.locator('[data-sample="bash"]') })
        for (const call of await calls.all()) {
          const summary = call.locator('[data-sample="bash"]')
          if (await summary.getAttribute('aria-expanded') === 'false') await summary.click()
          // TerminalBlock renders its command header first and its output body second.
          const output = call.locator('[data-terminal][data-body] > div:nth-child(2)')
          requireThat(await output.count() === 1, '本轮命令没有可核对的标准输出')
          outputs.push(await output.textContent())
        }
        let next = 0
        for (const token of bashTokens) {
          const index = outputs.findIndex((output, position) => position >= next && output.includes(token))
          requireThat(index !== -1, '本轮独立命令的实际标准输出未包含预期结果')
          next = index + 1
        }
      }
      // The response group belongs to the node itself; keep reasoning and user prompts out of assertions.
      const answer = await page.locator(`[data-chat-turn="${turn}"][data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]`).allTextContents()
      for (const token of tokens) requireThat(answer.join('\n').includes(token), '模型最终回复没有包含本项预期结果')
      return turn
    }

    async function signOut() {
      await page.getByRole('button', { name: /^(Account:|账号[：:])/ }).click()
      await page.getByRole('menuitem', { name: /^(Sign out|退出登录)$/ }).click()
      await page.locator('input[type="email"]').waitFor({ state: 'visible' })
    }

    await check(1, '首页和未登录入口', async () => {
      const home = await page.goto(options.url, { timeout: remaining() })
      requireThat(home?.status() === 200, `首页返回 HTTP ${home?.status() ?? '无响应'}`)
      const bootstrap = await context.request.get(`${options.url}/cloud/bootstrap`, { timeout: remaining() })
      requireThat(bootstrap.status() === 401, `未登录 bootstrap 返回 HTTP ${bootstrap.status()}，预期 401`)
      return '首页 200，bootstrap 401'
    })
    await check(2, '测试账号登录', async () => { await login(); return '登录后 bootstrap 200' }, [1])
    await check(3, '新建对话并获得模型回复', async () => {
      await page.getByRole('button', { name: /^(New session|新建会话|新建对话)$/i }).last().click()
      await page.getByRole('button', { name: /^(Choose workspace|选择工作区)$/ }).click()
      await page.getByRole('menuitem', { name: /^(Default workspace|默认工作区)$/ }).click()
      const token = `${prefix}-CHAT`
      await send(`Reply with exactly ${token}. Do not use tools.`, { tokens: [token] })
      sessionKey = await page.locator('[data-row-key^="session:"][aria-selected="true"]').getAttribute('data-row-key')
      requireThat(sessionKey, '未找到新建对话的侧栏记录')
      console.log(`本轮对话：${sessionKey}`)
    }, [2])
    await check(4, '沙箱执行一条命令', async () => {
      const token = `${prefix}-EXEC`
      await send(`Use Bash to execute exactly: printf '%s\\n' '${token}'. Report its actual stdout.`, { tokens: [token], bash: 1, bashTokens: [token] })
    }, [3])
    await check(5, '同一对话连续执行五条命令', async () => {
      const tokens = [1, 2, 3, 4, 5].map(n => `${prefix}-SEQ-${n}`)
      const commands = tokens.map(token => `printf '%s\\n' '${token}'`).join('; then ')
      await send(`Make exactly five separate sequential Bash tool calls, one per command. Do not combine commands into one call. Execute in order: ${commands}. Report all five actual stdout lines.`, { tokens, bash: 5, bashTokens: tokens })
      return '五次独立命令成功，覆盖每四条命令更换沙箱的路径'
    }, [3])
    await check(6, '按文件名和内容搜索', async () => {
      await send(`Use Bash to create ${searchFile} in the current workspace with exactly '${searchToken}' as its content. Then use the file-name search tool (glob) to find ${searchFile}, and the file-content search tool (grep) to find '${searchToken}' in it. Do not replace either search with shell commands. Report the actual matching filename and content.`,
        { tokens: [searchFile, searchToken], bash: 1, tools: ['glob', 'grep'] })
    }, [3])
    await check(7, '上传并读取文本文件', async () => {
      await page.getByRole('button', { name: /^(Add files or run commands|添加文件或运行命令)$/ }).click()
      await page.locator('input[type="file"]').setInputFiles({ name: uploadFile, mimeType: 'text/plain', buffer: Buffer.from(uploadToken) })
      await page.keyboard.press('Escape')
      // The random content is in the attachment only, never in the model prompt.
      await send(`Read the attached file ${uploadFile} and reply with its full exact content.`, { tokens: [uploadToken] })
    }, [3])
    await check(8, '生成文件、预览和下载', async () => {
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
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: remaining() }),
        preview.getByRole('button', { name: /^(Download|下载)$/ }).click(),
      ])
      const stream = await download.createReadStream()
      requireThat(stream, '下载没有返回可读取的内容')
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      requireThat(Buffer.concat(chunks).toString('utf8') === `${previewToken}\n`, '下载内容与本轮指定内容不一致')
    }, [3])
    await check(9, '重新登录后继续原对话执行命令', async () => {
      await signOut()
      await login()
      await page.locator(`[data-row-key="${sessionKey}"]`).click()
      await page.locator('[data-turn-process]').first().waitFor({ state: 'attached' })
      requireThat((await page.locator('[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]').allTextContents()).join('\n').includes(`${prefix}-CHAT`), '重新登录后没有找到原对话内容')
      const token = `${prefix}-RELOGIN`
      await send(`Use Bash to execute printf '%s\\n' '${token}'. Report actual stdout.`, { tokens: [token], bash: 1, bashTokens: [token] })
    }, [3])
    console.log('未做 10. MCP 检查；未做 11. 科研模式检查：留待对应迭代扩展')
    const passed = [...outcomes.values()].filter(value => value === 'pass').length
    const failed = [...outcomes.values()].filter(value => value === 'fail').length
    const skipped = [...outcomes.values()].filter(value => value === 'skip').length
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`合计：通过 ${passed}/9，失败 ${failed}，未验证 ${skipped}，用时 ${elapsed}秒`)
    return passed === 9 && Date.now() <= deadline && !options.mcp && !options.research ? 0 : 1
  } finally {
    clearTimeout(timer)
    await browser.close()
  }
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
