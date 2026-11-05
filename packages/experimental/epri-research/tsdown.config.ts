import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname,
  ['lib/types/index.js', 'lib/types/tools.js', 'lib/types/skills.js', 'lib/types/workbench.js', 'lib/types/web.js'], { hostPhase: true })
