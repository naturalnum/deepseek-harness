/** Existing native Sessions and an explicitly supplied current selection. */
export interface PersonalMcpSessionListState {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, { readonly displayTitle: string } | undefined>>
  readonly current: string | undefined
  readonly phase: 'pending' | 'ready'
}

/** Stable observable Session projection supplied by the native integration. */
export interface PersonalMcpSessionSource {
  readonly list: {
    getSnapshot(): PersonalMcpSessionListState
    subscribe(listener: () => void): () => void
  }
}

/** Public Session-controller fields used by the native selected-title projection. */
export interface PersonalMcpNativeSessionSource {
  readonly list: {
    getSnapshot(): {
      readonly ids: readonly string[]
      readonly byId: Readonly<Record<string, { readonly displayTitle: string;
        readonly retainedBy: { readonly mainView?: number } } | undefined>>
      readonly phase: 'pending' | 'ready'
    }
    subscribe(listener: () => void): () => void
  }
}

/** Project the public mainView reference count into the original stable Session source.
 * @param sessions - native Session-controller list; no private navigation state is read.
 * @returns a cached observable projection suitable for useSyncExternalStore.
 */
export function personalMcpSessionSource(sessions: PersonalMcpNativeSessionSource): PersonalMcpSessionSource {
  let prior: ReturnType<PersonalMcpNativeSessionSource['list']['getSnapshot']> | undefined
  let projection: PersonalMcpSessionListState | undefined
  return { list: {
    subscribe: listener => sessions.list.subscribe(listener),
    getSnapshot: () => {
      const snapshot = sessions.list.getSnapshot()
      if (snapshot !== prior || projection === undefined) {
        prior = snapshot
        projection = { ids: snapshot.ids, byId: snapshot.byId, phase: snapshot.phase,
          current: snapshot.ids.find(id => (snapshot.byId[id]?.retainedBy.mainView ?? 0) > 0) }
      }
      return projection
    },
  } }
}

/** One existing Session option; selecting it creates no new Session. */
export interface PersonalMcpSessionOption {
  readonly id: string
  readonly label: string
  readonly current: boolean
}

/** Show existing Session titles without retaining or creating a Session.
 * @param snapshot - explicit native Session projection. @returns selector rows.
 */
export function personalMcpSessionOptions(
  snapshot: PersonalMcpSessionListState,
): readonly PersonalMcpSessionOption[] {
  return snapshot.ids.map(id => ({
    id,
    label: snapshot.byId[id]?.displayTitle ?? id,
    current: id === snapshot.current,
  }))
}

/** Default to the current Session; otherwise require an explicit existing selection.
 * @param snapshot - existing native Sessions. @param selected - last explicit or default selection.
 * @returns an existing selected Session ID, or an empty string.
 */
export function resolvePersonalMcpCheckSession(
  snapshot: PersonalMcpSessionListState,
  selected: string,
): string {
  if (selected !== '' && snapshot.ids.includes(selected)) return selected
  return snapshot.current !== undefined && snapshot.ids.includes(snapshot.current)
    ? snapshot.current
    : ''
}
