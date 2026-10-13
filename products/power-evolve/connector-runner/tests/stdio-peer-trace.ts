import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

const traceSchema = z.object({
  event: z.string(), pid: z.number().int().positive().optional(), method: z.string().optional(),
  argv: z.array(z.string()).optional(), envKeys: z.array(z.string()).optional(),
  coverageDirectory: z.string().optional(), env: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict()

/** Read validated JSONL observations written by the test's owned peer.
 * @param file Absolute trace path within this test's temporary directory.
 * @returns Complete observations, or an empty array before the peer creates its trace.
 */
export function readStdioPeerTrace(file: string): Array<z.infer<typeof traceSchema>> {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8').trim()
  return text ? text.split('\n').map(line => traceSchema.parse(JSON.parse(line))) : []
}
