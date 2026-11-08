// @vitest-environment jsdom
import {act,createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import ResearchTasks from '../src/ui/ResearchTasks'

vi.mock('../src/ui/adapters/api',()=>({api:async(op:string)=>op==='tasks'?[{
 id:'task-conflict',recordId:'legacy-record',objective:'Synthetic task',basis:'synthetic',stage:'method',bindingConflict:true,
 next:'任务方法与关联记录不一致；原记录已保留，请新建任务或联系管理员核对。',steps:[],metrics:[],charts:[],
 record:{id:'legacy-record',revision:2,status:'draft',calculation:{}},report:{data:{markdown:'old'}},reportCurrent:false,
},{id:'task-missing',recordId:'missing-record',objective:'Missing task',basis:'synthetic',stage:'method',bindingConflict:true,next:'关联记录无法核验',steps:[],metrics:[],charts:[]}]:{methods:[]}}))

it('keeps historical identifiers visible while hiding conflicting record actions and results',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try {
  await act(async()=>{root.render(createElement(ResearchTasks,{onResumeRecord:vi.fn()}))})
  expect(host.textContent).toContain('任务方法与关联记录不一致')
  expect(host.textContent).toContain('legacy-record')
  expect(host.textContent).toContain('查看此前报告快照')
  expect(host.textContent).not.toContain('打开实验表')
  expect(host.textContent).not.toContain('导入 CSV')
  expect(host.textContent).not.toContain('已保存的计算结果')
  await act(async()=>{const select=host.querySelector('select')!;select.value='task-missing';select.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(host.textContent).toContain('missing-record')
  expect(host.textContent).not.toContain('为任务选择已导入的方法')
 }finally{await act(async()=>root.unmount());host.remove()}
})
