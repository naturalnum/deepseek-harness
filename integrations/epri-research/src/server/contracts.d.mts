/** Existing model and wire JSON validators remain domain-owned. */
export const contracts:Readonly<Record<string,{readonly description:string;readonly shape:object}>>;
export function validateArgs(op:string,args:unknown):Record<string,unknown>;
