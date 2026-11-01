import { expect, it, vi } from 'vitest'
import { AgentPresetSectionController } from '../src/client/section-store.ts'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'

it('shows actual roster and composition while refusing selection and raw native reads', async () => {
  const integration = {
    list: async () => ({ presets: [{ id: 'one', isDefault: true }, { id: 'two', isDefault: false }] }),
    read: async (id: string) => ({ agentPreset: id, content: '# configuration unavailable\n- actual-module' }),
  }
  const remote = { agentPresets: { list: vi.fn(), read: vi.fn(), select: vi.fn() }, settings: { update: vi.fn() } }
  const ctx = { agentPresetIntegration: integration, remote }
  const section = new AgentPresetSectionController(ctx as never)
  const seat = new AgentPresetSeatController(ctx as never, () => undefined)
  await section.load()
  expect(section.store.getSnapshot()).toMatchObject({ status: 'ready', readOnly: true,
    rows: [{ id: 'one', isDefault: true }, { id: 'two', isDefault: false }] })
  await section.view('two')
  expect(section.store.getSnapshot().view?.content).toContain('actual-module')
  await section.makeDefault('two')
  await seat.load()
  expect(seat.store.getSnapshot().options.map(row => row.id)).toEqual(['one'])
  await seat.select('two')
  seat.stage('two')
  await seat.apply()
  expect(remote.agentPresets.list).not.toHaveBeenCalled()
  expect(remote.agentPresets.read).not.toHaveBeenCalled()
  expect(remote.agentPresets.select).not.toHaveBeenCalled()
  expect(remote.settings.update).not.toHaveBeenCalled()
})
