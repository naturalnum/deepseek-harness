/** Only this new ARM identity's public references; never loads old private deployment or account files. */
import fs from 'node:fs'
import {armValidationParameters} from './arm-validation-settings.mjs'
import {createHash} from 'node:crypto'
import {renderAccountBase} from './prepare-feature-composition-v3.mjs'
const A='/opt/dsh-features/arm-native-01',R='/opt/dsh-features',p=JSON.parse(fs.readFileSync(A+'/plan.json'))
const sha=b=>createHash('sha256').update(b).digest('hex'),write=(path,value)=>fs.writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o400})
if(process.arch!=='arm64'||process.getuid()!==0)throw Error('Actual native ARM Root required')
const auth=JSON.parse(fs.readFileSync(R+'/auth-result.public.json'))
if(auth.status!=='initialized-and-verified'||auth.verified.bootstrapSessionsRemaining!==0)throw Error('Original new-identity auth initializer not settled')
const physical=JSON.parse(fs.readFileSync(A+'/static-arm-existing.json'))
const params=armValidationParameters(JSON.parse(fs.readFileSync(A+'/feature-root-v3.parameters.public-template.json')))
params.recipeVersion=physical.recipeVersion
params.database={database:p.database,host:p.pgHost,port:5432,user:p.pgRole,passwordRef:'DSH_SDK_ARM_PG_PASSWORD',ssl:false}
params.credentials={path:'/run/dsh-feature-root/credentials.json',authSecretRef:'DSH_SDK_ARM_AUTH_SECRET'}
params.server={host:'0.0.0.0',port:p.rootPort,publicOrigin:p.publicOrigin,internalAddress:'http://10.247.121.2:'+p.rootPort}
const preview=JSON.parse(fs.readFileSync(A+'/service-preview.010.json'));params.server={...params.server,...preview.server};params.servicePreview=preview.servicePreview
for(const route of preview.apiExactFetchRows){const existing=params.api.exactFetchRoutes.filter(r=>r.path===route.path);if(existing.length)throw Error('Preview approval already present; no implicit replacement');params.api.exactFetchRoutes.push(route)}
params.paths.sharedAccountsRoot=physical.accountsRoot
params.administrator={id:auth.userId,slotId:'account-slot-a'}
params.model.apiKeyRef='DEEPSEEK_API_KEY';params.files.maxResidentBytes=671088640;params.model.baseURL='http://127.0.0.1:9/'
params.researchSupplier={workloadImageDigest:p.images.workload,serverImageDigest:p.images.server};delete params.runtime.officeOrdinary
params.storage.probeHelperSha256=sha(fs.readFileSync(params.storage.probeHelperPath))
const base=fs.readFileSync(params.accountBase.path)
if(sha(base)!==params.accountBase.sha256)throw Error('Original public account base changed')
const rendered=renderAccountBase(base,params.model.apiKeyRef);params.nativeBaseSha256=sha(rendered)
fs.writeFileSync(R+'/account-base.yml',rendered,{flag:'wx',mode:0o444})
write(A+'/root-parameters.prepared.json',params)
const sdk=JSON.parse(fs.readFileSync(A+'/science-sdk-complete.public.json'))
sdk.images={workload:p.images.workload,server:p.images.server,execd:p.images.execd}
const pin=path=>({path,sha256:sha(fs.readFileSync(path))})
for(const name of ['config','dockerService','containerOps','deletionCompletion'])sdk.publicSources[name]=pin(A+'/sdk-arm-source/'+name+'.py')
sdk.publicSources.originalCompletion=pin(A+'/office-originalCompletion.py');sdk.publicSources.nativeSeccomp=pin(A+'/sdk-arm-source/nativeSeccomp.json')
sdk.supplierCompletionSource=pin(A+'/sdk-arm-source/supplierCompletionSource.py');sdk.verifier=pin(A+'/verify-science-sdk-v2.py')
sdk.sdk.listenPort=p.sdkPort;sdk.sdk.lifecycleBaseUrl='http://10.247.121.2:'+p.sdkPort+'/v1'
sdk.sdk.backendWorkPath=p.backendWorkPath;sdk.sdk.backendIsolationPath=p.backendWorkPath+'/isolation.toml'
write(A+'/sdk-parameters.prepared.json',sdk)
const template=JSON.parse(fs.readFileSync(params.sourceTemplate.path));template[0].insert.push({id:'sdk-linux-native-validation',name:A+'/native-validation-driver.mjs',config:{}})
write(A+'/root-with-validation.public-template.json.in',template)
const pinFile=path=>({path,sha256:sha(fs.readFileSync(path))})
const launch={schema:'dsh-feature-namespace-launch/v1',resourceId:p.resourceId,scripts:{launcher:pinFile(A+'/launch-feature-namespace.v3.sh'),steps:pinFile(A+'/feature-namespace-steps.v3.mjs'),measurement:pinFile(A+'/provision-static-v3.mjs')},staticInput:pinFile(A+'/static-arm-existing.json'),assets:{node:pinFile('/dsh-tools/node24'),seccomp:pinFile('/opt/dsh-feature-assets/app-seccomp.bpf'),storageProbe:pinFile('/opt/dsh-feature-assets/storage-probe-abi1.node'),files:pinFile('/opt/dsh-feature-assets/fd-abi8.node'),staging:pinFile('/opt/dsh-feature-assets/staging-abi1.node')},waitMs:1200000}
write(A+'/namespace-launch.input.json',launch)
console.log(JSON.stringify({prepared:true,resourceId:p.resourceId,authenticAdministratorId:auth.userId,credentialsPrinted:false,applicationStarted:false}))
