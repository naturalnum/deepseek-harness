/** Typed Cloud adapter face over the existing JSON-validated independent domain Store. */
/** Original Store failure; Cloud adapts only the two protocol recovery codes for native Remote transport. */
export class DomainError extends Error {
  readonly code: string;
  constructor(code:string,message:string);
}
export interface SuiteStore {
  execute(op:string,args:Record<string,unknown>,actor:'human'|'agent',signal?:AbortSignal,sessionId?:string|null):Promise<unknown>;
  waitForRun(id:string,sessionId:string):Promise<unknown>;
  close():void|Promise<unknown>;
}
export function openStore(directory:string,options:object):SuiteStore;
