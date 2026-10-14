/** Bounded stdin/stdout carrier for the isolated native filesystem utility. */
import { FsError } from '@deepseek-ai/dsh-fs'
import { executeNativeFsRequest } from './fs-worker.ts'

const chunks: Buffer[] = []
let size = 0
for await (const chunk of process.stdin) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  size += bytes.length
  if (size > 32 * 1024 * 1024) throw new Error('native_fs_request_too_large')
  chunks.push(bytes)
}
try {
  const value = await executeNativeFsRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  process.stdout.write(JSON.stringify({ ok: true, value }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error instanceof FsError ? error.code : 'FS_IO_ERROR',
    message: error instanceof FsError ? error.message : 'Native filesystem request failed.' }) + '\n')
}
