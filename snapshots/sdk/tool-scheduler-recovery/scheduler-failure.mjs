/** Reject one scheduler preparation to exercise the terminal internal-failure path. */
export const inject = ['tools', 'agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export function apply(ctx) {
  const settled = new WeakMap()
  ctx.on('agent/created', ({ agent }) => {
    ctx.effect(() => agent.onAfterClaim(async boundary => {
      if (boundary.events.some(event => event.data.outcome !== undefined || event.data.inserted.length !== 0)
        || boundary.events.reduce((sum, event) => sum + (event.data.removedCount ?? 0), 0) !== boundary.messages.length
        || boundary.to - boundary.from !== boundary.events.length) {
        throw new Error('Snapshot requires the complete canonical claim boundary')
      }
      await Promise.resolve()
      settled.set(agent, { turn: boundary.turn, step: boundary.step })
    }))
  })
  ctx.on('agent/pre-step', ({ agent, turn, step }, next) => {
    const boundary = settled.get(agent)
    if (boundary?.turn !== turn || boundary.step !== step) {
      throw new Error('Snapshot pre-step ran before the public post-claim barrier')
    }
    return next()
  })
  // Inspect the active instance's key so the fixture cannot introduce a second tools module.
  const key = Object.getOwnPropertySymbols(ctx.tools)
    .find(symbol => symbol.description === '@deepseek-ai/dsh-tools.scheduler')
  if (key === undefined) throw new Error('Scheduler failure fixture requires the active tool scheduler')
  const scheduler = ctx.tools[key]
  const prepare = scheduler.prepare
  ctx.effect(() => {
    scheduler.prepare = async input => {
      if (input.callId === 'scheduler-fail') {
        scheduler.prepare = prepare
        throw new Error('Snapshot scheduler preparation failed')
      }
      return prepare.call(scheduler, input)
    }
    return () => { scheduler.prepare = prepare }
  }, 'scheduler failure fixture')
}
