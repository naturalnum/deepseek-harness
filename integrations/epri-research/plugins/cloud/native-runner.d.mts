import type {ToolExecution} from '@deepseek-ai/dsh-tools';
import type {Config} from './index.ts';
/** Original native scientific execution transports; invocation scope is never reconstructed from JSON. */
export interface NativeResearchRuntime {
  withExecution<T>(exec:ToolExecution,work:()=>Promise<T>):Promise<T>;
  close():void;
  execution():ToolExecution|undefined;
  resources(payload:object):Promise<unknown>;
  readProjectFile(path:string,maxBytes:number):Promise<Uint8Array>;
  readonly engine:object;
  readonly documents:object;
  readonly git:object;
  fetch:typeof fetch;
}
export function createNativeResearchRuntime(config:Config,assertToolCurrent:(exec:ToolExecution)=>void,projectPath:(exec:ToolExecution)=>string):NativeResearchRuntime;
