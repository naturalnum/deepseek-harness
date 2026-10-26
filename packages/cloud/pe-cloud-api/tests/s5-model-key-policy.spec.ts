import { modelKeyBinding } from './model-key-policy-data.ts'
/** Root-only explicit key policy; no credential value or account is inferred from approval. */
import { Context } from '@deepseek-ai/cordis'
import { ExposureService } from '../src/root.ts'
import { MODEL_KEY_RPC_ENDPOINTS } from '../src/model-key-json.ts'
import { expect, it } from 'vitest'
import { parseApprovedConfigurationCatalog } from '../src/approved-catalog.ts'
const catalog={ recipeVersion:'s5',catalogVersion:'s5-key-1',maxEntries:32,maxStringBytes:256,maxCatalogBytes:8192,
  plugins:[{ id:'deepseek',entryId:'include:provider',moduleName:'@deepseek-ai/dsh-llm-deepseek-api-key',
    packageName:'@deepseek-ai/dsh-llm-deepseek-api-key',packageVersion:'0.2.1-rc.2',installable:false,toggleable:false }],
  skills:{ mode:'closed' },credentials:{ mode:'read-only' },fields:[] } as const
const modelKey={ bindings:[modelKeyBinding('provider')],maxKeyBytes:8192,maxVersionBytes:128,maxReplyBytes:4096,maxMetadataBytes:65536 }
it('keeps the existing catalog closed until all finite key bounds are explicitly selected',()=>{
  expect(parseApprovedConfigurationCatalog(catalog,'s5',true)?.modelKey).toBeUndefined()
  const actual=parseApprovedConfigurationCatalog({ ...catalog,modelKey },'s5',true)
  expect(actual?.modelKey).toEqual(modelKey);expect(Object.isFrozen(actual?.modelKey)).toBe(true)
  expect(actual?.credentials.mode).toBe('read-only')
})
it.each([{ ...modelKey,maxKeyBytes:Infinity },{ ...modelKey,maxReplyBytes:1 },{ ...modelKey,maxMetadataBytes:0 },
  { ...modelKey,extra:true },{ ...modelKey,bindings:[modelKeyBinding('')] }])('rejects incomplete or unbounded model-key configuration',(row)=>{
  expect(()=>parseApprovedConfigurationCatalog({ ...catalog,modelKey:row },'s5',true)).toThrow()
})
it('rejects native settings writers even when the independent key policy is selected',()=>{
  expect(()=>parseApprovedConfigurationCatalog({ ...catalog,modelKey },'s5',false)).toThrow()
})

it('requires all four exact original key handlers and keeps native write endpoints closed at Root load', async () => {
  const ctx=new Context(),rpc=MODEL_KEY_RPC_ENDPOINTS.map(endpoint=>({ endpoint,handlerId:'native:cloudModelKey',guard:'authenticated-account' as const }))
  const input={ recipeVersion:'s5',rpcEndpoints:rpc,streamEndpoints:[],exactFetchRoutes:[],allowedSettings:[],approvedConfiguration:{ ...catalog,modelKey } }
  try{
    for(const rows of [rpc.slice(1),rpc.map(row=>({ ...row,handlerId:'other' })),[...rpc,{ endpoint:'credentials/set',handlerId:'native:credentials',guard:'authenticated-account' as const }]]){
      expect(()=>new ExposureService(ctx,{ ...input,rpcEndpoints:rows })).toThrow()
    }
    expect(new ExposureService(ctx,input).approvedConfiguration?.modelKey).toEqual(modelKey)
  }finally{await ctx.fiber.dispose()}
})

it('detaches finite Root binding data and rejects duplicates, unknown fields and excess entries', () => {
  const bindings = [modelKeyBinding('provider'), { provider: 'second-declared', providerEntryId: 'second',
    moduleName: '@deepseek-ai/dsh-declared-provider', ref: 'SECOND_DECLARED_KEY' }]
  const parsed = parseApprovedConfigurationCatalog({ ...catalog, modelKey: { ...modelKey, bindings } }, 's5', true)!
  expect(parsed.modelKey?.bindings).toHaveLength(2)
  expect(Object.isFrozen(parsed.modelKey?.bindings[0])).toBe(true)
  bindings.splice(0)
  expect(parsed.modelKey?.bindings).toHaveLength(2)
  for (const invalid of [[], [modelKeyBinding('provider'), modelKeyBinding('another')],
    [{ ...modelKeyBinding('provider'), ref: 'not a ref' }], [{ ...modelKeyBinding('provider'), extra: true }],
    Array.from({ length: 33 }, (_, i) => ({ ...modelKeyBinding('p' + String(i)), provider: 'provider-' + String(i) }))]) {
    expect(() => parseApprovedConfigurationCatalog({ ...catalog, modelKey: { ...modelKey, bindings: invalid } }, 's5', true)).toThrow()
  }
})
