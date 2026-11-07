import {expect,it} from 'vitest'
import {isJsonValue} from '@deepseek-ai/dsh-util-values'
import {researchJsonResult} from '../plugins/cloud/result-json.ts'

it('matches existing HTTP omission only for optional object fields and detaches the result',()=>{
  const value={id:'task',record:undefined,evidence:null,nested:{report:undefined,rows:[{value:42,optional:undefined}]}}
  const result=researchJsonResult(value,1024)
  expect(result).toEqual(JSON.parse(JSON.stringify(value)))
  expect(isJsonValue(result)).toBe(true)
  expect(result).not.toBe(value)
  expect(value).toHaveProperty('record',undefined)
})

it.each([NaN,Infinity,-Infinity,-0,()=>42,1n,Symbol('unknown'),new Date(),new Map(),new Set(),new Uint8Array([1]),
  Object.assign(Object.create({custom:true}) as object,{value:42}),{toJSON(){return 42}},[undefined],Array(1),
  Object.defineProperty({},'hidden',{value:42}),{[Symbol('hidden')]:42}])('rejects non-JSON data before ordinary serialization can hide it: %s',value=>{
  expect(()=>researchJsonResult({value},1024)).toThrow(TypeError)
})

it('rejects cycles and accessors without invoking them, and accepts shared plain records',()=>{
  const cyclic:Record<string,unknown>={};cyclic.self=cyclic
  expect(()=>researchJsonResult(cyclic,1024)).toThrow(TypeError)
  let invoked=false
  expect(()=>researchJsonResult({get value(){invoked=true;return 42}},1024)).toThrow(TypeError)
  expect(invoked).toBe(false)
  const shared={value:42};expect(researchJsonResult({a:shared,b:shared},1024)).toEqual({a:{value:42},b:{value:42}})
  expect(()=>researchJsonResult(undefined,1024)).toThrow(TypeError)
})

it('bounds complete UTF-8 JSON including the native workbench envelope at the exact byte boundary',()=>{
  const body={requestId:'request',operation:'task_get',inputSha256:'a'.repeat(64),result:{title:'汉🙂'}}
  const bytes=Buffer.byteLength(JSON.stringify(body))
  expect(researchJsonResult(body,bytes)).toEqual(body)
  expect(()=>researchJsonResult(body,bytes-1)).toThrow(RangeError)
  for(const limit of [0,-1,NaN,Infinity,0.5])expect(()=>researchJsonResult(body,limit)).toThrow(RangeError)
})
