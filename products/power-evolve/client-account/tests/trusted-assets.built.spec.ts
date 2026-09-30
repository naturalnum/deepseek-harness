import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { JSDOM } from 'jsdom'
import { en } from '../src/client/locales.ts'

const directory = new URL('../lib/trusted/', import.meta.url)

test('published trusted assets list contains every public file and every HTML resource', async () => {
  const { trustedAccountAssets } = await import('../lib/index.mjs')
  assert.equal(trustedAccountAssets.href, directory.href)
  const manifest: unknown = JSON.parse(await readFile(new URL('asset-list.json', directory), 'utf8'))
  assert(Array.isArray(manifest) && manifest.every(value => typeof value === 'string'))
  assert.deepEqual(manifest, ['account.css', 'account.js', 'index.html'])
  assert.deepEqual((await readdir(directory)).filter(name => name !== 'asset-list.json').sort(), manifest)
  const html = await readFile(new URL('index.html', directory), 'utf8')
  const page = new JSDOM(html)
  try {
    for (const resource of page.window.document.querySelectorAll('script[src],link[href]')) {
      const url = resource.getAttribute('src') ?? resource.getAttribute('href')
      assert(url?.startsWith('/account/'))
      assert(manifest.includes(url.slice('/account/'.length)))
    }
    assert.equal(page.window.document.querySelectorAll('script:not([src]),style').length, 0)
  } finally { page.window.close() }
})

test('self-contained trusted bundle boots without a Host loader or dynamic code under the account CSP', async () => {
  const html = await readFile(new URL('index.html', directory), 'utf8')
  const script = await readFile(new URL('account.js', directory), 'utf8')
  assert(!script.includes('__ModuleLoader__'))
  const page = new JSDOM(html, { url: 'https://platform.test/account#password', runScripts: 'outside-only' })
  let dynamicCode = 0
  let network = 0
  Object.defineProperty(page.window, 'TextEncoder', { value: TextEncoder })
  Object.defineProperty(page.window, 'TextDecoder', { value: TextDecoder })
  Object.defineProperty(page.window, 'Function', { value: new Proxy(page.window.Function, {
    apply: () => { dynamicCode++; throw new Error('CSP disallows dynamic code') },
    construct: () => { dynamicCode++; throw new Error('CSP disallows dynamic code') },
  }) })
  Object.defineProperty(page.window, 'fetch', { value: async () => { network++; throw new Error('Unexpected network before login') } })
  try {
    new Script(script, { filename: 'account.js' }).runInContext(page.getInternalVMContext())
    for (let attempt = 0; attempt < 20 && !page.window.document.querySelector('input[type="password"]'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(page.window.document.querySelectorAll('input[type="password"]').length, 1)
    assert.equal(page.window.document.querySelector('h2')?.textContent, en.accountLogin)
    assert.equal(dynamicCode, 0)
    assert.equal(network, 0)
  } finally { page.window.close() }
})
