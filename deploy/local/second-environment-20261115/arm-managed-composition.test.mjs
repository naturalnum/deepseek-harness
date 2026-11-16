import {test} from 'node:test'
import assert from 'node:assert/strict'
import {managedAccountEntries,managedRootParameters} from './arm-managed-composition.mjs'
const old={id:'ssh-command',name:'@deepseek-ai/dsh-ssh-command-plugin',config:{port:1,user:'unconfigured'}}
test('managed composition retains Native execution and remote-server entries while retiring the missing external plugin',()=>{
 const entries=[{id:'execution-account',name:'cordis:pe-cloud-execution-account'},{id:'cloud-remote-servers',name:'cordis:pe-cloud-remote-servers'},old]
 assert.deepEqual(managedAccountEntries(entries),entries.slice(0,2));assert.equal(entries.length,3)
 assert.throws(()=>managedAccountEntries([{...old,name:'other'}]),/identity/)
})
test('the same retired plugin loses both approval and required inventory without widening another approval',()=>{
 const keep={id:'cloud-remote-servers',moduleName:'cordis:pe-cloud-remote-servers',packageName:'@deepseek-ai/dsh-pe-cloud-runtime',installable:false}
 const input={native:{requiredEntryIds:['execution-account','ssh-command','cloud-remote-servers']},api:{approvedConfiguration:{plugins:[keep,{id:old.id,moduleName:old.name,packageName:old.name}]}}}
 const result=managedRootParameters(input)
 assert.deepEqual(result.native.requiredEntryIds,['execution-account','cloud-remote-servers']);assert.deepEqual(result.api.approvedConfiguration.plugins,[keep]);assert.equal(input.native.requiredEntryIds.length,3)
 assert.throws(()=>managedRootParameters({...input,api:{approvedConfiguration:{plugins:[{id:old.id,moduleName:'other',packageName:old.name}]}}}),/identity/)
})
