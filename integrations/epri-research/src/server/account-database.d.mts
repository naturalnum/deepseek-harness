/** Lease-checked native SQLite wrapper with a finite page limit. */
export function openAccountDatabase(path:string,options:{assertCurrent():void;maxDatabaseBytes:number}):object;
