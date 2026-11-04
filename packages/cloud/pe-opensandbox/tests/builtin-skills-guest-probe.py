#!/usr/bin/env python3
"""Exercise real bundled assets in an explicitly mounted disposable ARM64 guest; never an app controller."""
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import time

out = Path('/workspace')
out.mkdir(exist_ok=True)
python = '/opt/dsh/runtime/dependencies/python/bin/python3'
node = '/opt/dsh/runtime/dependencies/node/bin/node'
cli = '/opt/dsh/runtime/dependencies/node/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js'
reports = Path('/opt/dsh/skills/reports')
results = []
os.environ.update(OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', PYTHONDONTWRITEBYTECODE='1', HOME='/workspace/home')
Path(os.environ['HOME']).mkdir(exist_ok=True)

def limits():
    for kind, value in [(resource.RLIMIT_AS, 536870912), (resource.RLIMIT_FSIZE, 67108864),
                        (resource.RLIMIT_NOFILE, 64), (resource.RLIMIT_NPROC, 64),
                        (resource.RLIMIT_CPU, 75), (resource.RLIMIT_CORE, 0)]:
        resource.setrlimit(kind, (value, value))

def run(name, argv, cwd=out):
    started = time.monotonic()
    try:
        answer = subprocess.run(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                preexec_fn=limits, timeout=180)
        code, data = answer.returncode, answer.stdout
    except subprocess.TimeoutExpired as error:
        code, data = 'timeout', error.stdout or b''
    (out / (name + '.log')).write_bytes(data)
    results.append(dict(name=name, argv=list(map(str, argv)), exit=code, seconds=time.monotonic()-started))
    print(name, code, flush=True)
    return code

(out/'limits.json').write_text(json.dumps({p:Path('/sys/fs/cgroup/'+p).read_text().strip()
    for p in ['cpu.max','memory.max','pids.max','memory.events']}, indent=2)+'\n')
(out/'author.py').write_text('''from docx import Document
from docx.oxml.ns import qn
from pptx import Presentation
from pptx.util import Inches
from openpyxl import Workbook, load_workbook
import json
p=Document();p.add_heading('电网设备状态研究',0);r=p.add_paragraph('本样例仅用于验证中文正文与引用[1]。').runs[0];r.font.name='Noto Serif CJK SC';r._element.rPr.rFonts.set(qn('w:eastAsia'),'Noto Serif CJK SC');p.save('generated.docx')
p=Document('generated.docx');p.paragraphs[1].add_run(' 已完成修改。');p.save('edited.docx');assert '已完成修改' in Document('edited.docx').paragraphs[1].text
s=Presentation();slide=s.slides.add_slide(s.slide_layouts[6]);slide.shapes.add_textbox(Inches(1),Inches(1), Inches(8), Inches(2)).text='电力设备研究';s.save('generated.pptx');s=Presentation('generated.pptx');s.slides[0].shapes[0].text+='：修改完成';s.save('edited.pptx');assert '修改完成' in Presentation('edited.pptx').slides[0].shapes[0].text
b=Workbook();ws=b.active;ws.title='统计';ws.append(['样本','数量']);ws.append(['甲',12]);ws.append(['乙',18]);ws.append(['合计','=SUM(B2:B3)']);b.save('generated.xlsx');b=load_workbook('generated.xlsx');b.active['B2']=15;b.save('edited.xlsx');assert load_workbook('edited.xlsx').active['B4'].value=='=SUM(B2:B3)'
json.dump({'docx_edit':True,'pptx_edit':True,'xlsx_formula_preserved':True,'xlsx_formula_cache_recalculated':False},open('authoring-result.json','w'),ensure_ascii=False)
''')
run('office-authoring',[python,'author.py'])
review='---\nproject_name: 电网状态研究（集成测试样例）\nlead_unit: 测试单位\ninvited: 5\nreturned: 5\napproved: 5\nrejected: 0\nreview_basis: 测试任务书与技术报告样例\n---\n\n# 前置审查意见中间稿\n'
for n in range(1,6):
    review+=f'\n## 专家{n}\n审稿人类型：测试视角{n}\n审查结论：同意通过（修改后）\n\n### 审查意见\n1. 样例报告覆盖测试任务要求，但引用[1]及关键指标仍需补齐可定位证据；建议建立任务要求与证据索引后复核。本意见仅用于技能集成测试，不构成实际验收意见。\n\n### 回复\n（待项目组填写）\n'
(out/'review.md').write_text(review)
fill=reports/'technical-report-pre-review/scripts/fill_review_template.py'
run('pre-review-validation',[python,str(fill),'review.md','review.docx','--validate-only'])
run('pre-review-docx',[python,str(fill),'review.md','review.docx'])
workflow=reports/'report-workflow-orchestrator/scripts/workflow_cli.py'
run('workflow-init',[python,str(workflow),'init','workflow.json','--project-id','integration-sample','--title','电网研究测试','--goal','验证编排状态与子技能资源'])
run('workflow-next',[python,str(workflow),'next','workflow.json','--request-out','handoff.json'])
run('workflow-intake',[python,str(workflow),'submit-intake','workflow.json',str(reports/'report-workflow-orchestrator/examples/project-intake.json')])
run('workflow-next-after-intake',[python,str(workflow),'next','workflow.json','--request-out','handoff-after-intake.json'])
for name, script in [('generator-runtime','power-grid-technical-report-writer/scripts/validate_runtime_pack_coverage.py'),
                     ('suite-rules','report-workflow-orchestrator/scripts/validate_rule_consistency.py')]:
    run(name,[python,str(reports/script)])
run('formatter-environment',[python,str(reports/'tech-report-writer/scripts/check_environment.py'),'--help'])
run('kit-capabilities',[node,cli,'capabilities'])
run('office-render',[node,cli,'render','--input','edited.docx','--output-dir','rendered-docx'])
run('office-recalculate',[node,cli,'recalculate','--input','edited.xlsx','--output','recalculated.xlsx'])
run('office-export-pdf',[node,cli,'convert','--input','edited.pptx','--output','slides.pdf'])
latex=out/'latex';shutil.copytree(reports/'latex-report-writer/assets/template',latex,dirs_exist_ok=True)
run('latex-compile',[python,str(reports/'latex-report-writer/scripts/build_latex_report.py'),str(latex/'example-report.tex')])
files=[dict(path=str(p.relative_to(out)),bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest())
       for p in sorted(out.rglob('*')) if p.is_file()]
(out/'probe-result.json').write_text(json.dumps(dict(results=results,files=files,
    qualification='Disposable default-candidate image with read-only prepared dependencies; not native Session/account/browser acceptance'),ensure_ascii=False,indent=2)+'\n')
