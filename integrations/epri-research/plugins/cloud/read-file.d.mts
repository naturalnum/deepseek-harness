import type {FileSystem,FsTarget} from '@deepseek-ai/dsh-fs';
/** Finite snapshot retained by the scientific consumer; each window remains owned by the original FS. */
export interface ReadOptions {
  readonly maxBytes:number;
  readonly chunkBytes:number;
  readonly signal?:AbortSignal;
  readonly check:()=>unknown;
  readonly expectedBytes?:number;
  readonly expectedSha256?:string;
}
export function readNativeFile(fs:Pick<FileSystem,'stat'|'readByteRange'>,target:FsTarget,options:ReadOptions):Promise<Buffer>;
