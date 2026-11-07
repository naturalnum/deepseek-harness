// Real Windows runtime and synthetic documents; no Docker, account, or customer data.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {runNativePython,nativePython} from '../src/server/native-runtime.mjs';
import {documentStatus,extractDocument} from '../dist/server/document-runtime.mjs';
import {openStore} from '../dist/server/service.mjs';

test('bundled Windows Python scrubs credentials, limits output and terminates cancelled/timed-out child trees',async()=>{
 assert.ok(nativePython(),'Set DS_NATIVE_PYTHON to the bundled interpreter');
 const dir=mkdtempSync(join(tmpdir(),'epri-native-test-'));
 const old=process.env.EPRI_NATIVE_TEST_API_KEY;process.env.EPRI_NATIVE_TEST_API_KEY='synthetic-do-not-inherit';
 try{
  const result=JSON.parse(await runNativePython(['-c','import os,json; print(json.dumps({"value":"电力测试", "credential":os.environ.get("EPRI_NATIVE_TEST_API_KEY"),"service":os.environ.get("DS_NATIVE_PYTHON")}))'],null));
  assert.deepEqual(result,{value:'电力测试',credential:null,service:null});
  const crt=JSON.parse(await runNativePython(['-c',`
import ctypes,json,sys,onnxruntime,cv2
from pathlib import Path
k=ctypes.WinDLL('kernel32'); k.GetModuleFileNameW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_uint32]
paths=[]
for name in ['msvcp140.dll','msvcp140_1.dll']:
    dll=ctypes.WinDLL(name); value=ctypes.create_unicode_buffer(32768); k.GetModuleFileNameW(dll._handle,value,len(value)); paths.append(Path(value.value).parent == Path(sys.executable).parent)
print(json.dumps(paths))
`],null));assert.deepEqual(crt,[true,true],'MSVC dependencies must load from the App, not the developer system');
  await assert.rejects(runNativePython(['-c','import sys; sys.stdout.write("x" * (9*1024*1024))'],null),{code:'LIMIT'});
  for(const kind of ['timeout','cancel']){
   const marker=join(dir,kind+'.pid'),cancel=new AbortController();
   const script=`import subprocess,sys,time,pathlib; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); pathlib.Path(${JSON.stringify(marker)}).write_text(str(child.pid)); time.sleep(60)`;
   const promise=runNativePython(['-c',script],null,{signal:cancel.signal,timeout:kind==='timeout'?3000:15000});
   const rejected=assert.rejects(promise,{code:kind==='timeout'?'TIMEOUT':'CANCELLED'});
   for(let i=0;i<100&&!existsSync(marker);i++)await delay(25);
   assert.ok(existsSync(marker),'The actual descendant must start before cancellation');
   const pid=Number(readFileSync(marker,'utf8'));if(kind==='cancel')cancel.abort();await rejected;
   assert.throws(()=>process.kill(pid,0),'The spawned Python descendant must be gone');
  }
 }finally{if(old===undefined)delete process.env.EPRI_NATIVE_TEST_API_KEY;else process.env.EPRI_NATIVE_TEST_API_KEY=old;rmSync(dir,{recursive:true,force:true});}
});

test('native OCR reads Chinese/English images and mixed PDFs offline, keeps pages/source hashes, and rejects bad/encrypted/oversize documents',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'epri-native-ocr-')),store=openStore(dir),checks=[];
 const call=(op,args={},session='native-ocr')=>store.execute(op,args,'human',undefined,session);
 try{
  const status=await documentStatus();assert.equal(status.available,true,JSON.stringify(status));assert.equal(status.execution,'native');
  const fixtures=JSON.parse(await runNativePython(['-c',`
import io,json,base64
from PIL import Image,ImageDraw,ImageFont
import pymupdf
image=Image.new('RGB',(1600,460),'white'); draw=ImageDraw.Draw(image); font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',50)
draw.text((60,60),'电力设备测试报告',font=font,fill='black'); draw.text((60,170),'Power sensor calibration 123.45',font=font,fill='black')
png=io.BytesIO(); image.save(png,format='PNG'); png=png.getvalue()
doc=pymupdf.open(); page=doc.new_page(); page.insert_text((60,80),'Synthetic power document: page one has selectable original text.')
page=doc.new_page(width=800,height=230); page.insert_image(page.rect,stream=png)
pdf=doc.tobytes(deflate=True); encrypted=doc.tobytes(deflate=True,encryption=pymupdf.PDF_ENCRYPT_AES_256,owner_pw='owner',user_pw='password')
large=pymupdf.open()
for _ in range(81):large.new_page()
print(json.dumps({k:base64.b64encode(v).decode() for k,v in {'png':png,'pdf':pdf,'encrypted':encrypted,'large':large.tobytes()}.items()}))
`],null));
  for(const [kind,extension] of [['png','.png'],['pdf','.pdf']]){
   const file=await call('attachment_put',{name:'合成OCR验收'+extension,contentBase64:fixtures[kind],requestId:randomUUID()});
   const result=await call('document_extract',{reference:file.reference,language:'chi_sim+eng'});
   assert.equal(result.reviewRequired,true);assert.equal(result.sourceSha256,file.reference.slice(11));assert.equal(result.engine,'pymupdf+rapidocr-onnx');
   const scanned=result.pages.at(-1);assert.equal(scanned.method,'ocr');assert.match(scanned.text,/电力设备测试报告/);assert.match(scanned.text,/123[.．]45/);
   if(kind==='pdf'){assert.equal(result.pages.length,2);assert.equal(result.pages[0].method,'text');assert.match(result.pages[0].text,/selectable original text/);assert.equal(scanned.page,2);}
   assert.deepEqual((await call('document_text',{reference:file.reference})).pages,result.pages);
   await assert.rejects(call('document_text',{reference:file.reference},'another-conversation'),{code:'NOT_FOUND'});
   checks.push({kind,pages:result.pages.map(p=>({page:p.page,method:p.method,text:p.text}))});
  }
  for(const content of [fixtures.encrypted,fixtures.large,Buffer.from('not a pdf').toString('base64')])await assert.rejects(extractDocument({extension:'.pdf',language:'chi_sim+eng',contentBase64:content}));
  const script=resolve('dist/server/document-native.py');
  const blockedNetwork=`import socket,runpy; blocked=lambda *a,**k: (_ for _ in ()).throw(RuntimeError('Network forbidden in OCR verification')); socket.socket.connect=blocked; socket.create_connection=blocked; runpy.run_path(${JSON.stringify(script)},run_name='__main__')`;
  const offline=JSON.parse(await runNativePython(['-c',blockedNetwork],JSON.stringify({extension:'.png',language:'chi_sim+eng',contentBase64:fixtures.png})));assert.match(offline.pages[0].text,/电力设备测试报告/);
  const output=resolve('verification/native-beta2-20261101');mkdirSync(output,{recursive:true});
  writeFileSync(join(output,'synthetic-ocr.png'),Buffer.from(fixtures.png,'base64'));writeFileSync(join(output,'synthetic-ocr.pdf'),Buffer.from(fixtures.pdf,'base64'));
  writeFileSync(join(output,'ocr-result.json'),JSON.stringify({status:'pass',checks,networkBlockedDuringOCR:true,customerDataModified:false},null,2));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
