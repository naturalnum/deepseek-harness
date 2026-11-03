/** Opt-in real HTTP/native I/O evidence. Requires disposable ext4 mount, compiled companion and built API/bridge modules. */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { open, stat, mkdir, readdir, rm, readFile } from 'node:fs/promises'
import { createReadStream, openSync, closeSync, readFileSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

if (!isMainThread) {
  const { loadStagingNative } = await import(pathToFileURL(workerData.wrapper))
  const companion = loadStagingNative(workerData.asset)
  const source = Promise.withResolvers()
  let tx
  parentPort.on('message', async message => {
    try {
      if (message.kind === 'begin') {
        tx = companion.begin(message.input, () => source.promise)
        parentPort.postMessage({ kind: 'ready' })
      } else if (message.kind === 'write') {
        tx.write(message.bytes); parentPort.postMessage({ kind: 'ack' })
      } else if (message.kind === 'finish') {
        source.resolve(); parentPort.postMessage({ kind: 'result', facts: await tx.finalize() })
      } else if (message.kind === 'abort') parentPort.postMessage({ kind: 'aborted', facts: tx.abort() })
    } catch (error) { parentPort.postMessage({ kind: 'error', message: String(error), facts: error.facts }) }
  })
} else {
  assert.equal(process.platform, 'linux')
  assert.equal(process.argv.length, 8, 'asset wrapper api bridge disposable-ext4-mount byte-count required')
  const [asset, wrapper, api, bridgeModule, root] = process.argv.slice(2, 7).map(value => resolve(value))
  const count = Number(process.argv[7]); assert(count >= 2 ** 30)
  const { registerWorkspaceTransfers } = await import(pathToFileURL(api))
  const { bridge } = await import(pathToFileURL(bridgeModule))
  await mkdir(join(root, 'account-a', 'default-workspace'), { recursive: true }); await mkdir(join(root, 'account-b'), { recursive: true })
  const project = join(root, 'account-a', 'default-workspace'), foreign = join(root, 'account-b')
  const routes = new Map(), disposals = []
  const lifetime = new AbortController(), cleanupFacts = []
  let held = 0, peakHeld = 0, peakRss = process.memoryUsage().rss
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 10)
  const resident = value => { held++; peakHeld=Math.max(peakHeld,held); return { value, release: () => { held-- } } }
  let backend = {
    lstat: async path => {
      try { const s = await stat(join(project,path));return resident({ type:s.isFile()?'file':'directory',size:s.size,version:`${s.ino}:${s.size}:${s.mtimeMs}` }) }
      catch (error) { if(error.code==='ENOENT')return resident(undefined); throw error }
    },
    readByteRange: async (path,range,signal) => {
      signal.throwIfAborted(); const fd=await open(join(project,path),'r')
      try { const b=Buffer.alloc(range.length);const {bytesRead}=await fd.read(b,0,b.length,range.offset);return resident(b.subarray(0,bytesRead)) }
      finally { await fd.close() }
    },
  }
  let pool, port
  const workspace = { id: 'default', path: project }
  if (process.env.POOL_MODULE) {
    const { LinuxFilesPool } = await import(pathToFileURL(process.env.POOL_MODULE))
    const parent = join(root, 'account-a'), fd = openSync(parent, 'r'), identity = statSync(parent, { bigint: true })
    const rootMountId = /mnt_id:\s+(\d+)/.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))[1]; closeSync(fd)
    pool = new LinuxFilesPool({ maxLanes: 2, maxRunning: 2, maxRunningPerLane: 1, maxQueued: 8, maxQueuedPerLane: 4,
      maxResidentBytes: 128 * 1024 * 1024, maxResidentBytesPerLane: 32 * 1024 * 1024, waitTimeoutMs: 30000,
      workerCount: 2, minimumHealthyWorkers: 2, workerReservationBytes: 8 * 1024 * 1024, replyOverheadBytes: 4096,
      readyTimeoutMs: 30000, drainTimeoutMs: 30000, helperPath: process.env.FD_HELPER,
      maxReadBytes: 65536, maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 65536,
      content: { maxEntries: 1000, maxNameBytes: 255, maxReplyBytes: 1024 * 1024, operationTimeoutMs: 30000 },
      staging: { helperPath: asset, maxFileBytes: 2 ** 33, maxBatchRefs: 1000, maxBatchBytes: 2 ** 34,
        maxSourceChunkBytes: 65536, operationTimeoutMs: 300000, reservationBytes: 4 * 1024 * 1024 },
    }, input => { const worker = new Worker(pathToFileURL(process.env.FILE_WORKER), { workerData: input });
      worker.on('error', error => console.error(error)); return worker })
    await pool.start()
    port = pool.bind({ accountId: 'disposable-a', epoch: '1', recipeVersion: 'large-file-evidence', lifetime: lifetime.signal },
      { rootPath: parent, rootDevice: String(identity.dev), rootInode: String(identity.ino), rootMountId }, () => {})
    backend = await port.workspaceContent(workspace, () => {}, lifetime.signal)
  }
  const ctx = { effect: fn => { disposals.push(fn()) }, connection:{ fetch:{ register: route => { routes.set(route.path,route);return async()=>{} } } } }
  registerWorkspaceTransfers(ctx,{maxFileBytes:2**33,maxTotalBytes:2**34,maxFiles:1000,chunkBytes:65536,maxPathBytes:4096,timeoutMs:300000},
    async id => { if(id!=='session-a')throw new Error('foreign-session');return {workspace:{path:project},assertCurrent(){},files:{workspaceContent:async()=>backend}} },
    ()=>{},lifetime.signal)
  const pattern=Buffer.alloc(65536,0x73), digest=createHash('sha256')
  for(let i=0;i<count;i+=pattern.length)digest.update(pattern.subarray(0,Math.min(pattern.length,count-i)))
  const expected=digest.digest('hex')
  const upload = async (req,res) => {
    const url=new URL(req.url,'http://test')
    if(req.headers.authorization!=='Bearer disposable-a'){res.writeHead(403);res.end();return}
    if (port) {
      const control = new AbortController(), abort = () => { control.abort(new Error('client-disconnected')) }
      req.once('aborted', abort)
      let bytes = 0
      try {
        const result = await port.stageFiles(workspace, [{ workspaceDirectory: '.',
          ref: { attachmentId: `sha256:${expected}`, name: url.searchParams.get('name') ?? 'large.bin', bytes: count },
          open: async function* () { for await (const chunk of req) {
            bytes += chunk.length
            for (let offset = 0; offset < chunk.length; offset += 65536) yield new Uint8Array(chunk.subarray(offset, offset + 65536))
          } },
        }], () => {}, control.signal)
        try { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ bytes, facts: result.value[0].facts })) }
        finally { result.release() }
      } catch (error) {
        if (!control.signal.aborted) console.error('Native pool upload failed:', error)
        cleanupFacts.push(error.facts)
        if (!res.destroyed) { res.writeHead(400); res.end() }
      } finally { req.off('aborted', abort) }
      return
    }
    const worker=new Worker(new URL(import.meta.url),{workerData:{asset,wrapper}})
    const control=new Int32Array(new SharedArrayBuffer(4))
    const send=message=>new Promise((accept,reject)=>{
      const failed=error=>{worker.off('message',received);reject(error)}
      const received=value=>{worker.off('error',failed);value.kind==='error'?reject(Object.assign(new Error(value.message),{facts:value.facts})):accept(value)}
      worker.once('message',received);worker.once('error',failed);worker.postMessage(message)
    })
    const abort=()=>{Atomics.store(control,0,1)};req.once('aborted',abort)
    const fd=openSync(project,'r'); const mount=/mnt_id:\s+(\d+)/.exec(readFileSync(`/proc/self/fdinfo/${fd}`,'utf8'))[1];closeSync(fd)
    const identity=statSync(project,{bigint:true});let complete=0
    try {
      await send({kind:'begin',input:{rootPath:project,device:String(identity.dev),inode:String(identity.ino),mountId:mount,
        name:url.searchParams.get('name')??'large.bin',digest:expected,expectedBytes:count,maxBytes:2**33,maxChunkBytes:65536,
        maxPathBytes:4096,timeoutMs:300000,cancel:control,workspaceDirectory:'.'}})
      for await(const chunk of req){for(let offset=0;offset<chunk.length;offset+=65536){
        if(Atomics.load(control,0))throw new Error('cancelled')
        const bytes=new Uint8Array(chunk.subarray(offset,offset+65536));await send({kind:'write',bytes});complete+=bytes.length
      }}
      assert.equal(complete,count)
      const result=await send({kind:'finish'});assert.equal(result.facts.clean,true)
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({bytes:complete,facts:result.facts}))
    }catch(error){
      try{cleanupFacts.push((await send({kind:'abort'})).facts)}catch(cleanup){cleanupFacts.push(error.facts??cleanup.facts)}
      if(!res.destroyed){res.writeHead(400);res.end()}
    }finally{req.off('aborted',abort);await worker.terminate()}
  }
  const server=createServer((req,res)=>{
    if(req.url.startsWith('/upload')){void upload(req,res).catch(error=>res.destroy(error));return}
    const handler={requestBodyMode:()=> 'buffered',fetch:request=>{
      if(request.headers.get('authorization')!=='Bearer disposable-a')return Promise.resolve(new Response(null,{status:403}))
      return routes.get(new URL(request.url).pathname).fetch(request)
    }}
    void bridge(req,res,handler,{},1048576).catch(error=>{console.error('Native HTTP response failed:',error);res.destroy(error)})
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`
  const start=Date.now();const startRss=process.memoryUsage().rss
  const post=async(name,stopAfter)=>{
    const req=httpRequest(`${base}/upload?name=${encodeURIComponent(name)}`,{method:'POST',headers:{authorization:'Bearer disposable-a','content-type':'application/octet-stream'}})
    const response=new Promise((accept,reject)=>{req.once('response',async res=>{let text='';for await(const c of res)text+=c;accept({status:res.statusCode,text})});req.once('error',reject)})
    void response.catch(()=>{})
    const writing=(async()=>{for(let sent=0;sent<count;){const chunk=pattern.subarray(0,Math.min(pattern.length,count-sent));if(!req.write(chunk))await once(req,'drain');sent+=chunk.length;if(stopAfter&&sent>=stopAfter){req.destroy();return}}req.end()})()
    await writing;return response
  }
  const hash=async response=>{const h=createHash('sha256');let bytes=0;for await(const c of response.body){bytes+=c.length;h.update(c)}return {bytes,sha256:h.digest('hex')}}
  try {
    const result=await post('large.bin');assert.equal(result.status,200);assert.equal(JSON.parse(result.text).bytes,count)
    const single=await fetch(`${base}/api/workspace-files/download?sessionId=session-a&path=large.bin`,{headers:{authorization:'Bearer disposable-a'}})
    assert.deepEqual(await hash(single),{bytes:count,sha256:expected})
    // Preserve equal basenames under separate relative directories in the streamed ZIP.
    await mkdir(join(project,'nested')); await import('node:fs/promises').then(fs=>fs.writeFile(join(project,'nested','large.bin'),pattern))
    const zip=await fetch(`${base}/api/workspace-files/download?sessionId=session-a&path=large.bin&path=nested/large.bin`,{headers:{authorization:'Bearer disposable-a'}})
    const zipFile=await open(join(root,'large.zip'),'w');let zipBytes=0
    try{for await(const chunk of zip.body){await zipFile.write(chunk);zipBytes+=chunk.length}}finally{await zipFile.close()}
    // Independent Python zipfile verifies CRC, entry names, lengths and SHA-256 outside the HTTP server process.
    const {spawnSync}=await import('node:child_process')
    const verified=spawnSync('python3',['-c',`import zipfile,hashlib,json\nz=zipfile.ZipFile(${JSON.stringify(join(root,'large.zip'))})\nout=[]\nfor e in z.infolist():\n h=hashlib.sha256();n=0\n with z.open(e) as f:\n  while True:\n   b=f.read(65536)\n   if not b:break\n   n+=len(b);h.update(b)\n out.append(dict(name=e.filename,bytes=n,sha256=h.hexdigest()))\nprint(json.dumps(out))`],{encoding:'utf8'})
    assert.equal(verified.status,0,verified.stderr);const zipEntries=JSON.parse(verified.stdout)
    assert.deepEqual(zipEntries[0],{name:'large.bin',bytes:count,sha256:expected});assert.equal(zipEntries[1].name,'nested/large.bin')
    assert.equal((await fetch(`${base}/api/workspace-files/download?sessionId=session-b&path=large.bin`,{headers:{authorization:'Bearer disposable-a'}})).status,400)
    assert.equal((await fetch(`${base}/api/workspace-files/download?sessionId=session-a&path=../account-b/large.bin`,{headers:{authorization:'Bearer disposable-a'}})).status,400)
    await post('cancelled.bin',8*1024*1024).catch(()=>{})
    for(let attempt=0;attempt<200&&cleanupFacts.length===0;attempt++)await new Promise(r=>setTimeout(r,10))
    assert(cleanupFacts.length>0)
    if (pool) {
      for (let attempt=0;attempt<1000&&(pool.inspect().work.running||pool.inspect().work.pending);attempt++)await new Promise(r=>setTimeout(r,10))
      console.error('Cancelled pool settlement:', JSON.stringify(pool.inspect().work))
      assert.equal(pool.inspect().work.running,0);assert.equal(pool.inspect().work.pending,0);assert.equal(pool.inspect().work.residentBytes,0)
    } else assert(cleanupFacts.every(f=>f?.closed&&f.clean&&!f.temporaryPresent))
    assert(!(await readdir(project)).some(name=>name==='cancelled.bin'||name.startsWith('.stage-')))
    const aborted=await fetch(`${base}/api/workspace-files/download?sessionId=session-a&path=large.bin`,{headers:{authorization:'Bearer disposable-a'}})
    const reader=aborted.body.getReader();await reader.read();await reader.cancel()
    await new Promise(r=>setTimeout(r,100));assert.equal(held,0)
    assert.deepEqual(await readdir(foreign),[])
    console.log(JSON.stringify({status:'passed',uploadedBytes:count,downloadedBytes:count,sha256:expected,zipBytes,zipEntries,
      startRss,peakRss,rssGrowth:peakRss-startRss,peakHeld,activeHeld:held,cancelCleanup:cleanupFacts,elapsedMs:Date.now()-start,
      productionNativeSink:true,productionHttpResponse:true,productionWorkerPool:!!pool, poolWork:pool?.inspect().work,fullCloudAccountComposition:false,productionQuotaChanged:false},null,2))
  }finally{
    clearInterval(sampler);if(pool)await pool.stop(Date.now()+30000);lifetime.abort();server.closeAllConnections();await new Promise(r=>server.close(r));for(const dispose of disposals)await dispose?.()
  }
}
