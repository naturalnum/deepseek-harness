/** Public assets and browser declarations through the native Loader and HTTP server. */
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ClientModules from '@deepseek-ai/dsh-client-modules'
import * as ResearchWeb from '../src/web.ts'

it('supplies real browser packages and serves only fixed public workbench assets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'research-web-')), configPath = join(home, 'cordis.yml')
  mkdirSync(join(home, 'node_modules', '@deepseek-ai'), { recursive: true })
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(home, 'node_modules', '@deepseek-ai', 'dsh-experimental-epri-research'), 'junction')
  symlinkSync(fileURLToPath(new URL('../../../../integrations/epri-research', import.meta.url)),
    join(home, 'node_modules', 'deepscientist-harness-suite'), 'junction')
  writeFileSync(join(home, 'package.json'), JSON.stringify({ name: 'research-web-fixture', dependencies: {
    '@deepseek-ai/dsh-experimental-epri-research': '0.2.1-rc.2', 'deepscientist-harness-suite': '0.2.1-cloud.20261105.1',
  } }))
  writeFileSync(configPath, JSON.stringify([
    { id: 'webserver', name: 'cordis:webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'modules', name: 'cordis:modules' },
    { id: 'research', name: 'cordis:research', config: {
      assetsRoot: fileURLToPath(new URL('../../../../integrations/epri-research/dist/ui', import.meta.url)),
      requestTimeoutMs: 10000, maxPendingRequests: 4,
    } },
  ]))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const ctx = await boot('research-web', configPath, [], (scope) => {
    owner = scope
    Object.assign(scope.loader.builtins, { webserver: WebServer, modules: ClientModules, research: ResearchWeb })
  })
  const url = 'http://127.0.0.1:' + String(ctx.webServer.port)
  const page = await fetch(url + '/research/')
  expect(page.status).toBe(200)
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
  expect(await page.text()).toContain('./public-config.js')
  const config = await (await fetch(url + '/research/public-config.js')).text()
  expect(config).toContain('"cloud":true')
  expect(config).not.toMatch(/token|password|accountId|dataDir/)
  expect((await fetch(url + '/research/api')).status).toBe(404)
  expect((await fetch(url + '/research/api', { method: 'POST' })).status).toBe(405)
  expect((await fetch(url + '/research/server/cloud-store.mjs')).status).toBe(404)
  expect((await fetch(url + '/research/app.js')).status).toBe(200)
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'research')
  await entry?.fiber?.dispose()
  expect((await fetch(url + '/research/')).status).toBe(404)
})
