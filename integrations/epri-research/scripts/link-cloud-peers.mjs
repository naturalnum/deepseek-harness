/** Development-only package links to the current monorepo Host; installation must finish before this script. */
import {readFileSync,readdirSync,mkdirSync,lstatSync,readlinkSync,symlinkSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const suite=resolve(dirname(fileURLToPath(import.meta.url)),'..'),repository=resolve(suite,'../..');
const peers=Object.keys(JSON.parse(readFileSync(join(suite,'package.json'),'utf8')).peerDependencies),sources=new Map();
for(const parent of [join(repository,'packages'),join(repository,'vendor')])for(const row of readdirSync(parent,{withFileTypes:true})){
  if(!row.isDirectory())continue;
  const directories=parent.endsWith('/vendor')?[join(parent,row.name)]:readdirSync(join(parent,row.name),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>join(parent,row.name,x.name));
  for(const directory of directories){try{const manifest=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));if(peers.includes(manifest.name))sources.set(manifest.name,directory);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
for(const name of peers){const target=sources.get(name);if(!target)throw new Error('Host workspace peer missing: '+name);
  const destination=join(suite,'node_modules',name);mkdirSync(dirname(destination),{recursive:true});
  try{const info=lstatSync(destination);if(!info.isSymbolicLink()||resolve(dirname(destination),readlinkSync(destination))!==target)throw new Error('Existing peer does not select current Host: '+name);}
  catch(error){if(error.code!=='ENOENT')throw error;symlinkSync(relative(dirname(destination),target),destination,'dir');}
}
console.log('Linked '+peers.length+' declared Host peers. Do not run installation commands while these links exist.');
