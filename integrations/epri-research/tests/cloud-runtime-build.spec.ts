/** Offline scientific supplier source checks; actual Linux execution remains with the build owner. */
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {it} from 'vitest'

it('keeps the standalone scientific interpreter separate from protected Office bytes and packages',()=>{
  execFileSync('python3',['-I','-B',fileURLToPath(new URL('./test_cloud_runtime.py',import.meta.url))],{timeout:10000,stdio:'pipe'})
})

it('joins bounded same-script image children and defers PDF and OCR libraries to their actual branch',()=>{
  execFileSync('python3',['-I','-B',fileURLToPath(new URL('./test_document_children.py',import.meta.url))],{timeout:10000,stdio:'pipe'})
})
