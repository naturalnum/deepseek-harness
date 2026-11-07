/** Collect a bounded snapshot through the original FS byte windows without increasing its per-call limits. */
import {createHash} from 'node:crypto';
const fail=()=>{throw new Error('科研文件读取不完整、版本已变化或超过配置容量；未确认成功。');};
export async function readNativeFile(fs,target,{maxBytes,chunkBytes,signal,check,expectedBytes,expectedSha256}) {
  const current=()=>{signal?.throwIfAborted();check();};
  current();
  const before=await fs.stat(target,signal);current();
  if(before?.type!=='file'||!Number.isSafeInteger(before.size)||before.size<0||before.size>maxBytes
    ||expectedBytes!==undefined&&before.size!==expectedBytes)fail();
  const bytes=Buffer.alloc(before.size),hash=createHash('sha256');
  for(let offset=0;offset<bytes.length;){
    const length=Math.min(chunkBytes,bytes.length-offset);
    const part=await fs.readByteRange(target,{offset,length},signal);current();
    if(part.byteLength!==length)fail();
    bytes.set(part,offset);hash.update(part);offset+=length;
  }
  const end=await fs.readByteRange(target,{offset:bytes.length,length:1},signal);current();
  const after=await fs.stat(target,signal);current();
  if(end.byteLength!==0||after?.type!=='file'||after.size!==before.size||after.version!==before.version
    ||expectedSha256!==undefined&&hash.digest('hex')!==expectedSha256)fail();
  return bytes;
}
