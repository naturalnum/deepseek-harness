#!/usr/bin/env python3
"""Qualify preserved Word catalogs, multi-page layout, publication and live Writer cancellation."""
import argparse
import os
import sys
import json
import resource
import hashlib
import subprocess
import time
import signal
from pathlib import Path
from copy import deepcopy
from zipfile import ZipFile
from unittest.mock import patch

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--output-directory', required=True, type=Path)
parser.add_argument('--runtime-directory', required=True, type=Path)
parser.add_argument('--soffice', required=True)
parser.add_argument('--pdftotext', required=True)
args = parser.parse_args()
for limit, value in [(resource.RLIMIT_AS, 536870912), (resource.RLIMIT_FSIZE, 67108864),
                     (resource.RLIMIT_NOFILE, 64), (resource.RLIMIT_NPROC, 64),
                     (resource.RLIMIT_CORE, 0), (resource.RLIMIT_CPU, 75)]:
    resource.setrlimit(limit, (value, value))
sys.path.insert(0, str(args.runtime_directory))
from refresh_word import refresh, Cancelled
from word_catalog import parse_xml, fields, catalogs, tag, NS, xml, write_copy, E, normalized
out = args.output_directory.resolve()
out.mkdir()
source = args.source.resolve(strict=True)
hash0 = hashlib.sha256(source.read_bytes()).hexdigest()
checks={}
def validate(before,after):
 with ZipFile(before) as a,ZipFile(after) as b:
  assert a.namelist()==b.namelist()
  for name in a.namelist():
   if name!='word/document.xml': assert a.read(name)==b.read(name), name
  original=parse_xml(a.read('word/document.xml')); updated=parse_xml(b.read('word/document.xml'))
  assert [v['code'] for v in fields(original)]==[v['code'] for v in fields(updated)]
  def body(root):
   for group,field in catalogs(root):
    from word_catalog import containing_paragraph
    first=containing_paragraph(field['begin']);last=containing_paragraph(field['end']);parent=first.getparent()
    section=last.find('w:pPr/w:sectPr',NS)
    saved=deepcopy(section) if section is not None else None
    for node in list(parent)[parent.index(first):parent.index(last)+1]: parent.remove(node)
    if saved is not None:
     p=E.Element(tag('p')); E.SubElement(p,tag('pPr')).append(saved); parent.insert(0,p)
   for node in list(root.iter()):
    if node.tag in (tag('bookmarkStart'),tag('bookmarkEnd')):
     node.getparent().remove(node)
   return E.tostring(root,method='c14n')
  assert body(original)==body(updated),'Non-catalog document changed'

def page_refs(directory):
 text=subprocess.check_output([args.pdftotext,'-layout',str(directory/'report.pdf'),'-'],text=True)
 (directory/'pdf-text.txt').write_text(text)
 pages=text.split('\f');rows=json.loads((directory/'catalogs.json').read_text())
 counts=0
 for group in rows.values():
  for row in group:
   matches=[]
   for index,page in enumerate(pages):
    lines=[line.strip() for line in page.splitlines() if line.strip()]
    if lines and lines[-1]==row['page'] and normalized(row['label']) in normalized(page): matches.append(index+1)
   assert len(matches)==1,(row,matches)
   counts+=1
 return {'references':counts,'pages':len([p for p in pages if p.strip()])}
first=out/'first';refresh(source,first,args.soffice,180,4);validate(source,first/'report.docx');checks['first']=page_refs(first)
repeat=out/'repeat';refresh(first/'report.docx',repeat,args.soffice,180,4);validate(first/'report.docx',repeat/'report.docx');checks['repeat']=page_refs(repeat)
with ZipFile(first/'report.docx') as a,ZipFile(repeat/'report.docx') as b:
 da=parse_xml(a.read('word/document.xml'));db=parse_xml(b.read('word/document.xml'))
 assert da.xpath('//w:bookmarkStart/@w:name',namespaces=NS)==db.xpath('//w:bookmarkStart/@w:name',namespaces=NS)
 assert (first/'catalogs.json').read_bytes()==(repeat/'catalogs.json').read_bytes()
checks['repeatHasNoBookmarkGrowth']=True
with ZipFile(source) as z: document=parse_xml(z.read('word/document.xml'))
body=document.find('w:body',NS);target=next(p for p in body.findall('w:p',NS) if '2 电网状态' in ''.join(p.xpath('.//w:t/text()',namespaces=NS)))
level=E.Element(tag('pPr'));E.SubElement(level,tag('pStyle')).set(tag('val'),'3')
for i in range(48):
 p=E.Element(tag('p'));p.append(deepcopy(level));r=E.SubElement(p,tag('r'));E.SubElement(r,tag('t')).text=f'扩展研究项目{i:03d}：复杂电网运行环境中的可靠性分析、状态估计和验证方案，以及跨系统数据质量核验流程'
 body.insert(body.index(target),p)
long=out/'long-source.docx';write_copy(source,long,{'word/document.xml':xml(document)})
long_out=out/'long';refresh(long,long_out,args.soffice,300,4);validate(long,long_out/'report.docx');checks['long']=page_refs(long_out)
# Existing destinations, malformed source and executable failure never publish a partial result.
marker=out/'existing';marker.mkdir();(marker/'keep').write_text('keep')
try: refresh(source,marker,args.soffice,20,4);raise AssertionError('accepted existing output')
except FileExistsError: pass
assert (marker/'keep').read_text()=='keep'
(out/'invalid.docx').write_text('invalid DOCX')
for label,src,exe,timeout in [('bad-source',(out/'invalid.docx'),args.soffice,30),('failed-command',source,'/bin/false',30),('timeout',source,args.soffice,0.001)]:
 dest=out/label
 try: refresh(src,dest,exe,timeout,4);raise AssertionError('unexpected success '+label)
 except (ValueError,RuntimeError,TimeoutError,FileNotFoundError) as e: pass
 except Exception as e:
  from zipfile import BadZipFile
  if not isinstance(e,BadZipFile): raise
 assert not dest.exists(), label
real_link = os.link
for case in ['publication-failure', 'publication-cancel']:
 dest=out/case
 count=[0]
 def interrupted_link(a,b):
  count[0]+=1
  if count[0] == 2:
   if case == 'publication-cancel': raise Cancelled('Publication interrupted')
   raise OSError('Publication failed')
  return real_link(a,b)
 with patch('refresh_word.os.link', side_effect=interrupted_link):
  try: refresh(source,dest,args.soffice,180,4);raise AssertionError('Unexpected publication')
  except (OSError,Cancelled): pass
 assert count[0] == 2 and not dest.exists(),case
checks['failureAndExistingPublication']=True
# Terminate while the real Writer process is live; verify every private-profile process has exited.
cancel=out/'cancelled'
p=subprocess.Popen([sys.executable,str(args.runtime_directory/'refresh_word.py'),str(long),str(cancel),'--soffice',args.soffice,'--timeout-seconds','300','--cancel-grace-seconds','4'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
until=time.monotonic()+20
found=False
while time.monotonic()<until:
 if cancel.exists() and any(cancel.glob('.word-refresh-*/profile')):
  for cmd in Path('/proc').glob('[0-9]*/cmdline'):
   try: data=cmd.read_bytes()
   except (OSError,ProcessLookupError): continue
   if b'soffice.bin' in data and str(cancel).encode() in data: found=True;break
 if found: break
 time.sleep(0.05)
assert found,'Writer never started before cancellation'
p.send_signal(signal.SIGTERM);stdout,stderr=p.communicate(timeout=15)
assert p.returncode!=0 and not cancel.exists(),(p.returncode,stderr.decode(),list(cancel.glob('*')))
for cmd in Path('/proc').glob('[0-9]*/cmdline'):
 try: data=cmd.read_bytes()
 except (OSError,ProcessLookupError):continue
 assert str(cancel).encode() not in data,cmd
checks['realWriterCancellationNoProcessOrFiles']=True
assert hashlib.sha256(source.read_bytes()).hexdigest()==hash0
checks['originalInputUnchanged']=True
checks['cgroup']={n:Path('/sys/fs/cgroup/'+n).read_text().strip() for n in ['cpu.max','memory.max','pids.max','memory.events','memory.peak']}
checks['output']=str(out)
(out/'RESULT.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n');print(json.dumps(checks,ensure_ascii=False))
