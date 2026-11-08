// @vitest-environment jsdom
/** Actual editor clicks and its parent review gate; no model, native execution or live account is used. */
import {act,createElement,useState} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import Workspace,{type AimdRunState} from '../src/reused/protocol/AimdProtocolWorkspace'
import {TaskRecordLink} from '../src/ui/ResearchTasks'
import {useRecordReviewState} from '../src/ui/record-review-state'

const delivery=vi.hoisted(()=>({request:vi.fn()}))
vi.mock('../src/ui/task-conversation.mjs',()=>({requestTaskConversation:delivery.request}))
vi.mock('../src/ui/adapters/api',()=>({sessionId:'review-ui',api:async()=>[{id:'task-ui',recordId:'record-ui',objective:'Synthetic review',next:'Review saved record',stage:'review'}]}))
vi.mock('../src/ui/adapters/useProtocolDocuments',()=>({useProtocolDocuments:()=>({documents:[],loading:false})}))
vi.mock('react-i18next',()=>({useTranslation:()=>({i18n:{language:'zh',resolvedLanguage:'zh'}})}))

const content='# Review UI\n\n{{step|inspect, check=True, checked_message="Inspect samples"}}\n\n{{var|expected_total: int, owner="system"}}\n\n{{var|valid_total: int, owner="system"}}\n\n{{var|missing_rate: float, owner="system"}}\n\n{{check|verified, checked_message="Reviewed input"}}\n'
const seed={id:'record-ui',status:'running' as const,createdAt:'2026-11-08T00:00:00Z',values:{expected_total:300,valid_total:270,missing_rate:10},tables:{},steps:{},checks:{},quizzes:{},calculation:{runId:'saved-calculation',pending:[],errors:[]}}
let root:Root|undefined
let container:HTMLDivElement
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.replaceChildren();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks()})

async function render(save:(value:AimdRunState)=>Promise<AimdRunState>){
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.useFakeTimers()
  container=document.createElement('div');document.body.append(container)
  let savedRevision=1
  const savedRuns:AimdRunState[]=[]
  const saveCall=vi.fn(async(value:AimdRunState)=>{const saved=await save(value);savedRuns.push(saved);savedRevision++;return saved})
  const deliveredRevisions:number[]=[]
  delivery.request.mockImplementation(async()=>{deliveredRevisions.push(savedRevision);return true})
  function Fixture(){
    const gate=useRecordReviewState(),[revision,setRevision]=useState(1)
    return createElement('div',null,
      createElement(TaskRecordLink,{record:{id:'record-ui',revision},disabled:gate.dirty||gate.saving,isReviewBlocked:gate.isReviewBlocked,onBack:()=>{}}),
      createElement(Workspace,{content,filePath:'protocol:review-ui@1',initialRun:seed,onDirtyChange:gate.setDirty,onBusyChange:gate.setSaving,
        adapter:{automatic:{targets:['expected_total','valid_total','missing_rate'],charts:[]},save:async value=>{const saved=await saveCall(value);setRevision(savedRevision);return saved},
          submit:async()=>{throw new Error('Review must never submit automatically')},create:async()=>{},export:async()=>{}}}))
  }
  root=createRoot(container)
  await act(async()=>root!.render(createElement(Fixture)))
  return {saveCall,savedRuns,deliveredRevisions}
}
function button(label:string){const value=[...container.querySelectorAll('button')].find(item=>item.getAttribute('aria-label')===label||item.textContent?.trim()===label);if(!value)throw new Error('Missing button: '+label);return value}
function check(){const value=container.querySelector<HTMLInputElement>('input[aria-label="Reviewed input"],[aria-label="Reviewed input"] input[type="checkbox"]');if(!value)throw new Error('Missing review checkbox');return value}

it('blocks an immediate same-event review click, explicitly saves metadata once, and then requests the saved revision',async()=>{
  const pending=Promise.withResolvers<AimdRunState>()
  const test=await render(()=>pending.promise)
  const review=button('在对话中确认结果')
  expect(review.disabled).toBe(false)
  await act(async()=>{button('Inspect samples').click();review.click()})
  expect(delivery.request).not.toHaveBeenCalled()
  expect(button('在对话中确认结果').disabled).toBe(true)
  await act(async()=>check().click())
  expect(container.textContent).toContain('有未保存的修改，请先保存草稿后再请求人工确认。')
  await act(async()=>{await vi.advanceTimersByTimeAsync(2500)})
  expect(test.saveCall).not.toHaveBeenCalled()
  await act(async()=>button('保存草稿').click())
  expect(test.saveCall).toHaveBeenCalledTimes(1)
  await act(async()=>button('在对话中确认结果').click())
  expect(delivery.request).not.toHaveBeenCalled()
  const submitted=test.saveCall.mock.calls[0]?.[0]
  if(!submitted)throw new Error('Explicit save absent')
  expect(submitted.steps.inspect).toBe(true);expect(submitted.checks.verified).toBe(true)
  expect(submitted.values).toEqual(seed.values)
  await act(async()=>pending.resolve(structuredClone(submitted)))
  expect(button('在对话中确认结果').disabled).toBe(false)
  await act(async()=>button('在对话中确认结果').click())
  expect(delivery.request).toHaveBeenCalledWith('task-ui','review')
  expect(test.deliveredRevisions).toEqual([2])
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
  expect(test.saveCall).toHaveBeenCalledTimes(1)
  expect(test.savedRuns[0]?.values).toEqual(seed.values)
})

it('retains dirty review state and calculation values after a failed save and does not request approval',async()=>{
  const test=await render(async()=>{throw new Error('fixture save failed')})
  await act(async()=>{button('Inspect samples').click();check().click()})
  await act(async()=>button('保存草稿').click())
  expect(container.textContent).toContain('保存未完成： Error: fixture save failed')
  expect(button('在对话中确认结果').disabled).toBe(true)
  await act(async()=>button('在对话中确认结果').click())
  expect(delivery.request).not.toHaveBeenCalled()
  expect(button('Inspect samples').getAttribute('aria-pressed')).toBe('true')
  expect(check().checked).toBe(true)
  expect(test.saveCall.mock.calls[0]?.[0].values).toEqual(seed.values)
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
  expect(test.saveCall).toHaveBeenCalledTimes(1)
  expect(test.savedRuns).toEqual([])
})
