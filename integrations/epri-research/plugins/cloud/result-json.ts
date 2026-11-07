/** Match the suite's HTTP JSON response while rejecting data JSON would silently change. */
export function researchJsonResult<T>(value:T,maxBytes:number):T {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new RangeError('科研结果需要显式的正整数字节上限。')
  function invalid():never {throw new TypeError('科研结果包含不能表示为 JSON 的数值或类型；请读取当前状态，勿自动重复已提交的操作。')}
  type Step={kind:'value';value:unknown;optional:boolean}|{kind:'leave';value:object}
  const ancestors=new Set<object>(),pending:Step[]=[{kind:'value',value,optional:false}]
  while(pending.length){
    const step=pending.pop()!
    if(step.kind==='leave'){ancestors.delete(step.value);continue}
    const item=step.value
    if(item===undefined&&step.optional)continue
    if(item===null||typeof item==='boolean'||typeof item==='string')continue
    if(typeof item==='number'){if(!Number.isFinite(item)||Object.is(item,-0))invalid();continue}
    if(typeof item!=='object'||item===null)invalid()
    if(ancestors.has(item))invalid()
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item)
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)invalid()
    const keys=Reflect.ownKeys(item)
    if(array&&keys.length!==(item as unknown[]).length+1)invalid()
    ancestors.add(item);pending.push({kind:'leave',value:item})
    for(const key of keys){
      if(array&&key==='length')continue
      const descriptor=Object.getOwnPropertyDescriptor(item,key)!
      if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))invalid()
      if(array&&(!/^(0|[1-9]\d*)$/u.test(key)||Number(key)>=(item as unknown[]).length))invalid()
      pending.push({kind:'value',value:descriptor.value,optional:!array})
    }
  }
  const body=JSON.stringify(value)
  if(Buffer.byteLength(body,'utf8')>maxBytes)throw new RangeError('科研结果超过已配置容量，请缩小读取范围；勿自动重复已提交的操作。')
  return JSON.parse(body) as T
}
