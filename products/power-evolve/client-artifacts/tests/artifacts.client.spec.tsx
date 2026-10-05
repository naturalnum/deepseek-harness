// @vitest-environment jsdom
/** Product catalog in the native Sidebar/Slot/document runtime; Host HTTP and file metadata are fixtures. */
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/src/client/index.ts'
import { apply as sidebarApply, inject as sidebarInject } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/index.ts'
import { apply as documentApply, inject as documentInject } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { hostFileOf } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/rpc.ts'
import type {} from '../src/client/index.ts'
import { ArtifactHttpClient, type Artifact } from '../src/client/api.ts'
import { ArtifactsTab } from '../src/client/ArtifactsTab.tsx'
import { en, zh } from '../src/client/locales.ts'

const SESSION = SessionId('598f346b-178c-4ef3-80ef-3a68f4cb4888')
const ORIGINAL = '7668a96c-43cd-4b9b-8bdb-a0e743802af7'
const WORKSPACE = 'b2cda611-5cf4-49f4-8606-7b8a66701e11'
const ID = 'a0197a8a-105d-42c6-b815-6e5155f10b5e'
const SHORTCUTS: readonly never[] = []
const runtimes: SlotTestRuntime[] = []
let animations: PropertyDescriptor | undefined

beforeEach(() => {
  animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
})

afterEach(async () => {
  try { for (const runtime of runtimes.splice(0)) await runtime.dispose() }
  finally {
    cleanup()
    if (animations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', animations)
  }
})

function artifact(filename: string, sessionId = SESSION): Artifact {
  return { artifactId: ID, workspaceId: WORKSPACE, sessionId, sourcePath: `out/${filename}`, filename,
    mime: 'application/octet-stream', sizeBytes: 5, sha256: 'a'.repeat(64), createdAt: '2026-10-05T00:00:00Z' }
}

async function boot(item: Artifact, preview: object = {}, language: 'en' | 'zh' = 'en', valid = true) {
  const requests: { route: string; request: object }[] = []
  const client = new ArtifactHttpClient(async (input, init) => {
    const route = String(input)
    requests.push({ route, request: JSON.parse(String(init?.body)).request })
    return Response.json(route.endsWith('artifactsList') ? { items: [item], nextCursor: null }
      : { artifactId: ID, mime: 'text/plain', sizeBytes: 5, truncated: false, ...preview })
  })
  const rt = await SlotTestRuntime.create()
  runtimes.push(rt)
  rt.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(false) } } as never)
  rt.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn() } as never)
  rt.ctx.provide('shortcuts', { register: () => () => {}, catalog: {
    getSnapshot: () => SHORTCUTS, subscribe: () => () => {},
  } } as never)
  const locale = new LocaleRuntime(rt.ctx)
  locale.setLocale(language)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  await rt.declare({ rightbar: { kind: 'single', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' } })
  await rt.sessions.add({ id: SESSION })
  await rt.sessions.retainFor(rt.ctx, SESSION, { source: 'mainView' }).ready
  await rt.mount({ inject: [...resourcesInject], apply: resourcesApply })
  const opened: string[] = []
  const unavailable = { ok: false as const, error: Object.assign(new Error('Fixture file unavailable'), {
    code: 'gateway/not_found' as const, isDSHRemoteError: true as const, details: {},
  }) }
  rt.ctx.effect(() => rt.ctx.resources.register({ protocol: 'file', open: async function* (address) {
    opened.push(address)
    // A metadata denial keeps binary renderers idle; this test exercises navigation, not PDF/Office engines.
    yield unavailable
  } }))
  const readBytes = vi.fn().mockResolvedValue(unavailable)
  rt.remote.provideNamespaces({
    workspaceFiles: { read: vi.fn().mockResolvedValue(unavailable), readBytes },
    officeToPdf: { generation: vi.fn().mockResolvedValue({ ok: true, value: 'fixture-generation' }),
      render: vi.fn().mockResolvedValue(unavailable) },
  })
  await rt.mount({ inject: [...sidebarInject], apply: sidebarApply })
  await rt.mount({ inject: [...documentInject], apply: documentApply })
  await rt.mount({ inject: ['slots', 'locale', 'sidebarRightTabs'], apply(ctx) {
    ctx.effect(() => ctx.locale.register('powerEvolve.artifacts', { en, zh }))
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'power-evolve/test-artifacts', kind: 'testArtifacts',
      priority: 'builtin', title: () => 'Artifacts' }))
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab',
      key: 'power-evolve/test-artifacts', locale: 'powerEvolve.artifacts',
      inject: () => ({ sessionId: SESSION, workspaceId: WORKSPACE, client, changed: new EventTarget() }),
    }, ArtifactsTab))
  } })
  const view = rt.renderSlot('rightbar', { width: 600, viewportWidth: 1440, canShow: true })
  act(() => { rt.ctx.sidebarRight.openTab('testArtifacts') })
  const query = within(view.container)
  if (valid) await query.findByText(item.filename)
  else await query.findByRole('alert')
  return { rt, view, query, requests, opened, readBytes }
}

it.each(['report.pdf', 'sheet.XLSX', '报告 #1%20?.docx', 'slides.pptx'])(
  'opens %s through the native resource API without catalog preview or download', async filename => {
    const h = await boot(artifact(filename))
    fireEvent.click(h.query.getByRole('button', { name: en.preview }))
    await vi.waitFor(() => expect(h.opened).toHaveLength(1))
    const selected = h.rt.ctx.sidebarRight.active()!
    expect(hostFileOf(selected.contentId)).toEqual({ sessionId: SESSION, path: `/artifacts/${ID}/${filename}` })
    await vi.waitFor(() => expect(h.readBytes).toHaveBeenCalled())
    expect(h.readBytes.mock.calls[0]?.slice(0, 2)).toEqual([SESSION, `/artifacts/${ID}/${filename}`])
    expect({ kind: selected.kind, address: selected.contentId, file: hostFileOf(selected.contentId) }).toMatchSnapshot()
    expect(h.requests.map(item => item.route)).toEqual(['/api/powerEvolve/artifactsList'])
    expect(h.view.container.querySelector('a[download]')).toBeNull()
  },
)

it('opens a Workspace catalog artifact through its original Session while keeping the viewed Session', async () => {
  const h = await boot(artifact('original.pdf', ORIGINAL))
  fireEvent.change(h.query.getByRole('combobox'), { target: { value: 'workspace' } })
  await vi.waitFor(() => expect(h.requests).toHaveLength(2))
  await h.query.findByText('original.pdf')
  fireEvent.click(h.query.getByRole('button', { name: en.preview }))
  await vi.waitFor(() => expect(h.opened).toHaveLength(1))
  expect(h.requests[1]!.request).toEqual({ workspaceId: WORKSPACE, limit: 30 })
  expect(h.rt.ctx.sidebarRight.mounted.getSnapshot()).toBe(SESSION)
  expect(hostFileOf(h.rt.ctx.sidebarRight.active()!.contentId)).toEqual({ sessionId: ORIGINAL,
    path: `/artifacts/${ID}/original.pdf` })
  expect(h.readBytes).toHaveBeenCalledWith(ORIGINAL, `/artifacts/${ID}/original.pdf`, {}, expect.any(AbortSignal))
})

it.each(['en', 'zh'] as const)('keeps bounded text and authenticated download in the catalog (%s)', async language => {
  const copy = language === 'en' ? en : zh
  const h = await boot(artifact('report.txt'), { text: 'hello' }, language)
  const download = h.query.getByRole('link', { name: copy.download })
  expect(download.getAttribute('href')).toBe(`/api/powerEvolve/artifacts/${ID}/content`)
  expect(download.getAttribute('download')).toBe('report.txt')
  fireEvent.click(h.query.getByRole('button', { name: copy.preview }))
  await h.query.findByText('hello')
  expect({ title: h.view.container.querySelector('.pe-artifacts-header strong')?.textContent,
    scopes: h.view.container.querySelector('select')?.textContent,
    buttons: [...h.view.container.querySelectorAll('.pe-artifacts-tab button')].map(button => button.textContent),
    preview: h.view.container.querySelector('.pe-artifacts-preview')?.textContent,
  }).toMatchSnapshot()
  expect(h.opened).toEqual([])
  expect(h.requests[1]).toEqual({ route: '/api/powerEvolve/artifactsPreview', request: { artifactId: ID } })
})

it('retains image catalog preview without opening a native resource', async () => {
  const h = await boot(artifact('image.png'), { mime: 'image/png', data: 'aGVsbG8=' })
  fireEvent.click(h.query.getByRole('button', { name: en.preview }))
  await vi.waitFor(() => expect(h.view.container.querySelector('.pe-artifacts-image')?.getAttribute('src'))
    .toBe('data:image/png;base64,aGVsbG8='))
  expect(h.opened).toEqual([])
})

it.each([{ ...artifact('report.pdf'), artifactId: ID.toUpperCase() }, artifact('../report.pdf')])(
  'rejects malformed catalog metadata before exposing a preview action ($filename/$artifactId)', async item => {
    const h = await boot(item, {}, 'en', false)
    expect(h.query.getByRole('alert').textContent).toBe(en.listFailed)
    expect(h.query.queryByRole('button', { name: en.preview })).toBeNull()
    expect(h.opened).toEqual([])
    expect(h.requests).toHaveLength(1)
  },
)
