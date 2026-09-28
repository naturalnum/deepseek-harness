const prefix = 'power-evolve-cloud-title:'

/** The native workspace/create path field is an opaque title transport, never a filesystem path. */
export function cloudWorkspaceTitlePath(value: string): string {
  const title = value.trim()
  if (title.length < 1 || title.length > 80 || [...title].some(character => {
    const point = character.codePointAt(0)
    return point === undefined || point <= 0x1f || point === 0x7f
  })) throw new Error('Invalid cloud Workspace title')
  const path = `${prefix}${encodeURIComponent(title)}`
  if (path.length > 1024) throw new Error('Cloud Workspace title is too long')
  return path
}
