/** Fixed Root record and single-FD publication bridge through the existing candidate namespace entry. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { execInCandidate } from './inspect.mjs'
import stateModule from './native-delivery-state.cjs'

const { NativeDeliveryUnconfirmed } = stateModule
const DECIMAL = /^[0-9]{1,32}$/
const HASH = /^[a-f0-9]{64}$/
const programDigest = sources => createHash('sha256').update(sources.join('\0')).digest('hex')

function protectedDirectory(value, asset = false) {
  return value && typeof value.path === 'string'
    && (asset ? value.path === '/opt/dsh-feature-assets' : value.path.startsWith('/opt/dsh-features/pe-cloud-delivery/'))
    && !value.path.includes('\\') && !value.path.includes('\0')
    && value.path.split('/').every((part, index) => index === 0 || (part && part !== '.' && part !== '..'))
    && DECIMAL.test(value.device) && DECIMAL.test(value.inode)
}

/**
 * Construct the original namespace entry with only the approved private journal FD9 and asset FD10.
 * @param {object} current Current namespace and holder identity from the normal controller.
 * @param {object} approved The approved external private directory and public native asset parent.
 * @param {string} moduleSource Exact source of the fixed Root record/publication implementation.
 * @param {string} profileSource Exact source of the existing single-profile check implementation.
 * @param {string} productSource Exact existing product-files source; only its read function is used here.
 * @returns {string[]} Candidate argv; varying values travel in stdin, never interpolated shell text.
 */
export function nativeAuthorityCommand(current, approved, moduleSource, profileSource, productSource) {
  if (!Number.isSafeInteger(current.holder?.pid) || current.holder.pid < 1
    || !DECIMAL.test(current.holder.startTicks) || !/^mnt:\[[0-9]+\]$/.test(current.namespaceId)
    || current.holder.namespaceId !== current.namespaceId || current.nodePath !== '/dsh-tools/node24'
    || current.seccompPath !== '/opt/dsh-feature-assets/app-seccomp.bpf'
    || !Number.isSafeInteger(current.shutdownTimeoutMs) || current.shutdownTimeoutMs <= 0
    || !protectedDirectory(approved.journal) || !protectedDirectory(approved.assetParent, true)
    || approved.journal.path === approved.assetParent.path
    || typeof moduleSource !== 'string' || typeof profileSource !== 'string' || typeof productSource !== 'string') {
    throw new NativeDeliveryUnconfirmed('authority-input')
  }
  const target = `${moduleSource}
const nativeProfileModule={exports:{}};
(function(module,exports,require){${profileSource}\n})(nativeProfileModule,nativeProfileModule.exports,require);
const nativeProductModule={exports:{}};
(function(module,exports,require){${productSource}\n})(nativeProductModule,nativeProductModule.exports,require);
const nativeRequest=JSON.parse(fs.readFileSync(0,'utf8'));
const nativeContext=nativeRequest.context;
if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid()!==0
  ||fs.readlinkSync('/proc/self/ns/mnt')!==nativeContext.namespaceId
  ||fs.readlinkSync('/proc/'+nativeContext.holder.pid+'/ns/mnt')!==nativeContext.namespaceId)throw new NativeDeliveryUnconfirmed('authority-namespace');
const nativeStat=fs.readFileSync('/proc/'+nativeContext.holder.pid+'/stat','utf8');
if(nativeStat.slice(nativeStat.lastIndexOf(')')+2).trim().split(/\\s+/)[19]!==nativeContext.holder.startTicks)throw new NativeDeliveryUnconfirmed('authority-holder');
const nativeStore=new NativeRecordStore(9);
const nativeAssetView=fs.lstatSync('/opt/dsh-feature-assets'),nativeAssetParent=fs.fstatSync(10);
if(!nativeAssetView.isDirectory()||nativeAssetView.isSymbolicLink()||nativeAssetView.uid!==0
  ||(nativeAssetView.mode&0o022)!==0||nativeAssetView.dev!==nativeAssetParent.dev
  ||nativeAssetView.ino!==nativeAssetParent.ino)throw new NativeDeliveryUnconfirmed('asset-view-changed');
const nativeMounts=JSON.parse(require('node:child_process').execFileSync('findmnt',
  ['--json','--target','/opt/dsh-feature-assets','--output','TARGET,SOURCE,FSTYPE,OPTIONS'],
  {encoding:'utf8',maxBuffer:131072,stdio:['ignore','pipe','pipe']})).filesystems;
if(nativeMounts.length!==1||!nativeMounts[0].options.split(',').includes('ro')
  ||nativeMounts[0].options.split(',').includes('noexec'))throw new NativeDeliveryUnconfirmed('asset-view-policy');
let nativeValue;
switch(nativeRequest.method){
case 'reserve':nativeValue=nativeStore.reserve(nativeRequest.value);break;
case 'advance':nativeValue=nativeStore.advance(nativeRequest.value.expected,nativeRequest.value.next);break;
case 'read':nativeValue=nativeStore.read();break;
case 'observe':nativeValue=nativeProfileModule.exports.observeTuple(nativeRequest.value,
  nativeProductModule.exports.collectManagedFiles);break;
case 'protected-inputs':{
  if(!nativeRequest.approved.profile)throw new NativeDeliveryUnconfirmed('profile-input-missing');
  nativeValue=nativeProfileModule.exports.readProtectedInputs(nativeRequest.approved.profile.maxProfileBytes);break;
}
case 'directory-facts':{
  nativeProfileModule.exports.requireUnpublishedDirectoryAsset(nativeRequest.approved.asset);
  if(!nativeRequest.approved.profile)throw new NativeDeliveryUnconfirmed('profile-input-missing');
  nativeValue=nativeProfileModule.exports.readDirectoryFacts(nativeRequest.approved.profile);break;
}
case 'preview-profile':{
  if(!nativeRequest.approved.profile||nativeRequest.approved.journal.path!==
    '/opt/dsh-features/pe-cloud-delivery/'+nativeRequest.value.operation+'/native-record')throw new NativeDeliveryUnconfirmed('profile-preview-input');
  nativeValue=nativeProfileModule.exports.previewProfile({...nativeRequest.approved.profile,operation:nativeRequest.value.operation});
  break;
}
case 'publish':{
  const nativeRecord=nativeStore.read();
  if(nativeRecord.phase!=='publish-intent'||nativeRecord.operation!==nativeRequest.value.operation
    ||nativeRecord.descriptorSha256!==nativeRequest.value.descriptorSha256)throw new NativeDeliveryUnconfirmed('publication-intent');
  nativeValue=publishFdAsset(10,nativeRequest.value.expected,Buffer.from(nativeRequest.value.bytes,'base64'));
  nativeValue.targetLoad=nativeProfileModule.exports.loadPublishedAsset(nativeValue,nativeContext,{nativeProtocol:nativeRequest.approved.profile?.nativeProtocol});
  if(nativeRequest.approved.profile)nativeValue.profile=nativeProfileModule.exports.publishProfile(
    {...nativeRequest.approved.profile,operation:nativeRequest.value.operation,
      descriptorSha256:nativeRequest.value.descriptorSha256},nativeRecord);
  break;
}
case 'continue-publish':{
  if(!nativeRequest.approved.profile)throw new NativeDeliveryUnconfirmed('profile-input-missing');
  if(nativeRequest.value.binding.programSha256!==${JSON.stringify(programDigest([moduleSource, profileSource, productSource]))})
    throw new NativeDeliveryUnconfirmed('continuation-program-source');
  nativeValue=nativeProfileModule.exports.continueNativePublish(
    {...nativeRequest.value,approved:nativeRequest.approved},nativeContext,nativeStore,nativeProductModule.exports,
    {requireNativePublishIntent,inspectPublishedFdAsset});
  break;
}
case 'unbind':case 'bind':case 'seal':{
  if(!nativeRequest.approved.profile)throw new NativeDeliveryUnconfirmed('profile-input-missing');
  nativeValue=nativeProfileModule.exports.selectProfile(nativeRequest.method,
    {...nativeRequest.approved.profile,operation:nativeRequest.value.operation,
      descriptorSha256:nativeRequest.value.descriptorSha256},nativeStore.read());
  break;
}
default:throw new NativeDeliveryUnconfirmed('authority-method');
}
console.log(JSON.stringify(nativeValue));`
  const outer = `const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const input=fs.readFileSync(0),request=JSON.parse(input),context=request.context;
const handles=[];let failure,result;
function openDirectory(spec,privateRecord){
 for(let p=spec.path;p!=='/';p=path.posix.dirname(p)){
  const s=fs.lstatSync(p);
  if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==0||(s.mode&0o022)!==0)throw Error('unprotected-native-parent');
 }
 const fd=fs.openSync(spec.path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);handles.push(fd);
 const s=fs.fstatSync(fd);
 if(String(s.dev)!==spec.device||String(s.ino)!==spec.inode||s.uid!==0
   ||(privateRecord&&(s.gid!==0||(s.mode&0o7777)!==0o700)))throw Error('native-directory-changed');
 return fd;
}
try{
 if(process.getuid()!==0||process.platform!=='linux')throw Error('Root-required');
 const journal=openDirectory(request.approved.journal,true),asset=openDirectory(request.approved.assetParent,false);
 result=execFileSync('nsenter',['-t',String(context.holder.pid),'-m','--root','--wd=/',context.nodePath,'-e',${JSON.stringify(target)}],
  {input,encoding:'utf8',maxBuffer:1048576,env:{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'},
   stdio:['pipe','pipe','pipe','ignore','ignore','ignore','ignore','ignore','ignore',journal,asset]});
}catch(error){failure=error}
for(const fd of handles.reverse())try{fs.closeSync(fd)}catch(error){failure=error}
if(failure){console.error('native-authority-unconfirmed');process.exitCode=1}else process.stdout.write(result);`
  if (Buffer.byteLength(outer) >= 131071) throw new NativeDeliveryUnconfirmed('authority-argument-budget')
  return ['/proc/' + current.holder.pid + '/root/dsh-tools/node24', '-e', outer]
}

/**
 * Bind the fixed Root methods to current approved directories, retaining no ambient Root/config access.
 * @param {object} current Normal controller namespace and retained holder identity.
 * @param {object} approved Approved directories and exact asset; absent profile permits record reads and matching JS only.
 * @param {Function} execute Existing candidate executor; omitted uses execInCandidate.
 * @returns {Promise<object>} Root record authority plus the one fixed publication method.
 */
export async function createNativeAuthority(current, approved, execute = execInCandidate) {
  const moduleSource = await readFile(new URL('./native-delivery-state.cjs', import.meta.url), 'utf8')
  const profileSource = await readFile(new URL('./native-profile.cjs', import.meta.url), 'utf8')
  const productSource = await readFile(new URL('./product-files.cjs', import.meta.url), 'utf8')
  const command = nativeAuthorityCommand(current, approved, moduleSource, profileSource, productSource)
  if (!approved.asset || !HASH.test(approved.asset.sha256) || !HASH.test(approved.asset.sourceSha256)
    || !Number.isSafeInteger(approved.asset.bytes) || !Number.isSafeInteger(approved.asset.maxAssetBytes)
    || approved.asset.bytes < 1 || approved.asset.bytes > approved.asset.maxAssetBytes
    || !Number.isSafeInteger(approved.asset.maxPathBytes) || approved.asset.maxPathBytes < 1
    || approved.asset.parentDevice !== approved.assetParent.device
    || approved.asset.parentInode !== approved.assetParent.inode) throw new NativeDeliveryUnconfirmed('authority-asset')
  const directory = value => ({ path: value.path, device: value.device, inode: value.inode })
  const pinned = { context: { namespaceId: current.namespaceId, nodePath: current.nodePath,
    seccompPath: current.seccompPath,
    shutdownTimeoutMs: current.shutdownTimeoutMs,
    holder: { pid: current.holder.pid, startTicks: current.holder.startTicks, namespaceId: current.holder.namespaceId } },
  approved: { journal: directory(approved.journal), assetParent: directory(approved.assetParent),
    asset: { sha256: approved.asset.sha256, sourceSha256: approved.asset.sourceSha256,
      bytes: approved.asset.bytes, maxAssetBytes: approved.asset.maxAssetBytes,
      maxPathBytes: approved.asset.maxPathBytes,
      parentDevice: approved.asset.parentDevice, parentInode: approved.asset.parentInode } } }
  if (approved.profile !== undefined) {
    const input = approved.profile
    const metadata = value => ({ device: value.device, inode: value.inode, uid: value.uid,
      gid: value.gid, mode: value.mode, nlink: value.nlink })
    const selection = value => ({ source: value.source, sha256: value.sha256,
      identity: value.identity === undefined ? undefined : metadata(value.identity) })
    pinned.approved.profile = { target: input.target, maxProfileBytes: input.maxProfileBytes,
      original: selection(input.original), candidate: input.candidate === undefined ? undefined : selection(input.candidate),
      originalHelperPath: input.originalHelperPath,
      nextHelperPath: '/opt/dsh-feature-assets/fd-skill-store-v1-' + approved.asset.sha256 + '.node',
      protectedInputs: input.protectedInputs === undefined ? undefined
        : input.protectedInputs.map(value => ({ path: value.path, sha256: value.sha256,
          identity: metadata(value.identity) })) }
    if (input.nativeProtocol !== undefined) {
      if (input.nativeProtocol !== 'directory-enumeration-v1') throw new NativeDeliveryUnconfirmed('authority-native-protocol')
      Object.assign(pinned.approved.profile, { nativeProtocol: input.nativeProtocol,
        directoryPaging: structuredClone(input.directoryPaging),
        directoryFacts: input.directoryFacts === undefined ? undefined : structuredClone(input.directoryFacts) })
    }
  }
  const request = async (method, value) => {
    try {
      const output = await execute(command, { input: JSON.stringify({ ...pinned, method, value }) })
      return JSON.parse(output)
    } catch (error) { throw new NativeDeliveryUnconfirmed('authority-' + method, error) }
  }
  return {
    snapshotApproved: () => structuredClone(pinned.approved),
    reserve: pins => {
      if (pins.kind === 'fd-profile' && (pinned.approved.profile?.candidate === undefined
        || pinned.approved.profile.protectedInputs?.length !== 5)) {
        throw new NativeDeliveryUnconfirmed('profile-input-missing')
      }
      if (pinned.approved.journal.path !== '/opt/dsh-features/pe-cloud-delivery/' + pins.operation + '/native-record') {
        throw new NativeDeliveryUnconfirmed('operation-directory-mismatch')
      }
      return request('reserve', pins)
    },
    advance: (expected, next) => request('advance', { expected, next }),
    read: () => request('read'),
    observeTuple: groups => request('observe', groups),
    readProtectedInputs: async () => {
      if (pinned.approved.profile === undefined) throw new NativeDeliveryUnconfirmed('profile-input-missing')
      const value = await request('protected-inputs')
      pinned.approved.profile.protectedInputs = structuredClone(value)
      return value
    },
    readDirectoryFacts: async () => {
      const value = await request('directory-facts')
      pinned.approved.profile.directoryFacts = structuredClone(value)
      return value
    },
    previewProfile: async pins => {
      const value = await request('preview-profile', { operation: pins.operation })
      if (pinned.approved.profile === undefined) throw new NativeDeliveryUnconfirmed('profile-input-missing')
      pinned.approved.profile.candidate = { source: value.source, sha256: value.sha256 }
      return value
    },
    unbind: pins => request('unbind', { operation: pins.operation, descriptorSha256: pins.descriptorSha256 }),
    bind: pins => request('bind', { operation: pins.operation, descriptorSha256: pins.descriptorSha256 }),
    seal: pins => request('seal', { operation: pins.operation, descriptorSha256: pins.descriptorSha256 }),
    publish: async (pins, bytes) => {
      if (!Buffer.isBuffer(bytes) || bytes.length !== pinned.approved.asset.bytes) {
        throw new NativeDeliveryUnconfirmed('authority-asset-bytes')
      }
      const expected = pinned.approved.asset
      const result = await request('publish', { operation: pins.operation,
        descriptorSha256: pins.descriptorSha256, expected, bytes: bytes.toString('base64') })
      if (!isDeepStrictEqual({ sha256: result.sha256, sourceSha256: result.sourceSha256, parent: result.parent },
        { sha256: expected.sha256, sourceSha256: expected.sourceSha256,
          parent: { device: expected.parentDevice, inode: expected.parentInode } })) {
        throw new NativeDeliveryUnconfirmed('authority-asset-receipt')
      }
      if (pinned.approved.profile !== undefined) {
        if (result.profile?.source !== pinned.approved.profile.candidate?.source
          || result.profile?.sha256 !== pinned.approved.profile.candidate?.sha256 || result.profile?.identity === undefined) {
          throw new NativeDeliveryUnconfirmed('authority-profile-receipt')
        }
        pinned.approved.profile.candidate = structuredClone(result.profile)
      }
      return result
    },
    continuePublish: async (expected, groups, binding) => {
      const result = await request('continue-publish', { expected, groups, binding })
      if (result.profile?.source !== pinned.approved.profile?.candidate?.source
        || result.profile?.sha256 !== pinned.approved.profile?.candidate?.sha256
        || result.profile?.identity === undefined) throw new NativeDeliveryUnconfirmed('continuation-profile-receipt')
      pinned.approved.profile.candidate = structuredClone(result.profile)
      return result
    },
  }
}
