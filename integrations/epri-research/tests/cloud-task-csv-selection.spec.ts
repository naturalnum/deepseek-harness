// @vitest-environment jsdom
/** Task changes and out-of-order method replies must not retarget the CSV controls. */
import {readFileSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import ResearchTasks from '../src/ui/ResearchTasks'

const requests=vi.hoisted(()=>({api:vi.fn()}))
vi.mock('../src/ui/adapters/api',()=>({api:requests.api}))
type MethodSource={files:Record<string,string>}
const examples=resolve(dirname(fileURLToPath(import.meta.url)),'../examples')
const quality:MethodSource={files:{'protocol.aimd':readFileSync(resolve(examples,'interactive-power/protocol.aimd'),'utf8')}}
const calibration:MethodSource={files:{'protocol.aimd':readFileSync(resolve(examples,'power-methods/calibration/protocol.aimd'),'utf8')}}
const task=(id:string,methodId:string)=>({id,methodId,methodVersion:'1.0.0',objective:id,basis:'synthetic',stage:'input',steps:[],next:'Import input',metrics:[],charts:[],record:{id:'record-'+id,revision:1,status:'draft'}})
let root:Root|undefined
let container:HTMLDivElement
const pending:ReturnType<typeof Promise.withResolvers<MethodSource>>[]=[]

afterEach(async()=>{
 await act(async()=>{
  root?.unmount();root=undefined
  for(const reply of pending.splice(0))reply.resolve(quality)
 })
 container?.remove()
 vi.unstubAllGlobals();requests.api.mockReset()
})

function deferred(){const reply=Promise.withResolvers<MethodSource>();pending.push(reply);return reply}
async function render(tasks:ReturnType<typeof task>[],method:(id:string)=>Promise<MethodSource>){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 requests.api.mockImplementation(async(op:string,args:Record<string,unknown>={})=>{
  if(op==='tasks')return tasks
  if(op==='method_catalog')return {methods:[]}
  if(op==='method_get')return method(String(args.id))
  if(op==='attachment_put')return {reference:'csv-selection-fixture'}
  if(op==='task_import_csv')return {}
  throw new Error('Unexpected CSV test operation: '+op)
 })
 container=document.createElement('div');document.body.append(container);root=createRoot(container)
 await act(async()=>root!.render(createElement(ResearchTasks,{onResumeRecord:vi.fn()})))
}
async function selectTask(id:string){
 const select=container.querySelector<HTMLSelectElement>('label > select:not([aria-label])')!
 await act(async()=>{select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}))})
}
function csvTable(){return container.querySelector<HTMLSelectElement>('select[aria-label="CSV 目标表格"]')}

it('withholds the previous task table while the newly selected method is still loading',async()=>{
 const next=deferred()
 await render([task('quality','quality'),task('calibration','calibration')],id=>id==='quality'?Promise.resolve(quality):next.promise)
 expect(csvTable()?.value).toBe('measurements')
 await selectTask('calibration')
 expect(csvTable()).toBeNull()
 expect(container.querySelector('input[aria-label="导入任务 CSV"]')).toBeNull()
 await act(async()=>next.resolve(calibration))
 expect(csvTable()?.value).toBe('points')
 const file=new File(['point,reference,measured\r\nA,1,3\r\n'],'calibration.csv',{type:'text/csv'})
 Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode('point,reference,measured\r\nA,1,3\r\n').buffer})
 const input=container.querySelector<HTMLInputElement>('input[aria-label="导入任务 CSV"]')!
 Object.defineProperty(input,'files',{value:[file]})
 await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})))
 expect(requests.api).toHaveBeenCalledWith('task_import_csv',expect.objectContaining({id:'calibration',table:'points',expectedRecordRevision:1}))
})

it('keeps the selected task method after an older method reply arrives last',async()=>{
 const old=deferred(),next=deferred()
 await render([task('quality','quality'),task('calibration','calibration')],id=>id==='quality'?old.promise:next.promise)
 await selectTask('calibration')
 await act(async()=>next.resolve(calibration))
 expect(csvTable()?.value).toBe('points')
 await act(async()=>old.resolve(quality))
 expect(csvTable()?.value).toBe('points')
})

it('resets a table choice for a different task using the same method without replacing the control',async()=>{
 const multiple:MethodSource={files:{'protocol.aimd':'{{var|first, owner="human", subvars=[var(value: int)]}}\n\n{{var|second, owner="human", subvars=[var(value: int)]}}\n'}}
 await render([task('first-task','shared'),task('second-task','shared')],async()=>multiple)
 const select=csvTable()!
 expect(select.value).toBe('first')
 await act(async()=>{select.value='second';select.dispatchEvent(new Event('change',{bubbles:true}))})
 expect(select.value).toBe('second')
 await selectTask('second-task')
 expect(csvTable()).toBe(select)
 expect(csvTable()?.value).toBe('first')
})
