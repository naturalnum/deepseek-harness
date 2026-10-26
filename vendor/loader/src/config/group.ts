import { Context, Service } from '@deepseek-ai/cordis'
import { Entry, type EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'

/** Runtime owner for a list of child loader entries. */
export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []
  private updateTask: { readonly promise: Promise<void>; pending: boolean } | undefined

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.fiber.entry
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
  }

  async create(options: Omit<EntryOptions, 'id'>) {
    this.ctx.loader.updateGuard?.create(this, options)
    const id = this.tree.ensureId(options)
    const entry: Entry = this.tree.store[id] ??= new Entry(this.ctx.loader)
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    await entry.update(options, true, true)
    return entry.id
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    if (!entry) return
    this.ctx.loader.updateGuard?.remove(entry)
    entry.fiber?.dispose()
    if (!isDispose) {
      this.unlink(entry.options)
    }
    delete this.tree.store[id]
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  /** Join actual updates enrolled on this group before its observed work settles.
   * Call from an external observer; child setup and cleanup must not await their own group update.
   * @returns Joined settlement, including updates enrolled while waiting; preserves the first observed failure.
   */
  async awaitUpdate(): Promise<void> {
    let observed = this.updateTask
    let failure: { readonly error: unknown } | undefined
    while (observed !== undefined) {
      try { await observed.promise } catch (error) { failure ??= { error } }
      if (observed === this.updateTask) break
      observed = this.updateTask
    }
    if (failure !== undefined) throw failure.error
  }

  /** Update this group's children without serializing independent native updates.
   * @param config Replacement child entry list.
   * @returns This update's original async caller promise, retaining its rejection responsibility;
   * awaitUpdate separately observes enrolled internal work.
   */
  async update(config: EntryOptions[]): Promise<void> {
    const previous = this.updateTask, actual = Promise.withResolvers<undefined>()
    const joined = previous?.pending ? Promise.allSettled([previous.promise, actual.promise]).then((results) => {
      for (const result of results) if (result.status === 'rejected') throw result.reason
    }) : actual.promise
    const current = { promise: joined, pending: true }
    this.updateTask = current
    void joined.then(() => { current.pending = false }, () => { current.pending = false })
    void this.updateChildren(config).then(() => { actual.resolve(undefined) }, actual.reject)
    return actual.promise
  }

  private async updateChildren(config: EntryOptions[]) {
    this.ctx.loader.updateGuard?.group(this, config)
    const oldConfig = this.data as EntryOptions[]
    this.data = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]
    await Promise.all(ids.map(async (id) => {
      if (newMap[id]) {
        await this.create(newMap[id]).catch((error) => {
          this.ctx.logger.error(error)
        })
      } else {
        this.remove(id)
      }
    }))
  }

  stop() {
    for (const options of this.data) {
      this.remove(options.id, true)
    }
  }
}

/** Plugin that mounts a nested loader entry group. */
export class Group extends EntryGroup {
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context, public config: EntryOptions[]) {
    super(ctx, ctx.fiber.entry!.parent.tree)
    ctx.on('internal/update', (config) => {
      this.update(config)
    })
  }

  async* [Service.init]() {
    yield () => this.stop()
    await this.update(this.config)
  }
}
