/** Original native byte windows and version tokens; the scientific consumer alone collects the bounded snapshot. */
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import {expect,it,onTestFinished,vi} from 'vitest'
import {readNativeFile} from '../plugins/cloud/read-file.mjs'

async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'research-range-')),ctx=new Context()
  const fiber=await ctx.plugin(FsLocal,{cwd:directory})
  onTestFinished(async()=>{await fiber.dispose();await rm(directory,{recursive:true,force:true})})
  const path=join(directory,'bytes.bin'),data=Buffer.from('汉🙂'.repeat(40000))
  await writeFile(path,data)
  return {fs:ctx.get('fs')!,target:await ctx.get('fs')!.resolve(path),path,data}
}

it('collects exact binary bytes through small native windows and rejects a whole-result limit before reading',async()=>{
  const f=await fixture(),range=vi.spyOn(f.fs,'readByteRange'),check=vi.fn()
  const options={maxBytes:f.data.length,chunkBytes:4096,check,expectedBytes:f.data.length,
    expectedSha256:createHash('sha256').update(f.data).digest('hex')}
  expect(await readNativeFile(f.fs,f.target,options)).toEqual(f.data)
  expect(range.mock.calls.length).toBeGreaterThan(60)
  expect(range.mock.calls.every(call=>call[1].length<=4096)).toBe(true)
  range.mockClear()
  await expect(readNativeFile(f.fs,f.target,{...options,maxBytes:f.data.length-1})).rejects.toThrow('超过配置容量')
  expect(range).not.toHaveBeenCalled()
})

it('refuses corruption, a changed native version and cancellation between actual byte windows',async()=>{
  const f=await fixture(),options={maxBytes:f.data.length,chunkBytes:4096,check:()=>{}}
  await expect(readNativeFile(f.fs,f.target,{...options,expectedSha256:'0'.repeat(64)})).rejects.toThrow('未确认成功')
  const original=f.fs.readByteRange.bind(f.fs)
  let mutate=true
  const range=vi.spyOn(f.fs,'readByteRange').mockImplementation(async(target,window,signal)=>{
    const value=await original(target,window,signal)
    if(mutate){mutate=false;await writeFile(f.path,Buffer.alloc(f.data.length,1))}
    return value
  })
  await expect(readNativeFile(f.fs,f.target,options)).rejects.toBeDefined()
  range.mockRestore()
  const controller=new AbortController()
  vi.spyOn(f.fs,'readByteRange').mockImplementation(async(target,window,signal)=>{
    const value=await original(target,window,signal);controller.abort();return value
  })
  await expect(readNativeFile(f.fs,f.target,{...options,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
})
