#!/usr/bin/env bash
# Run inside the built Sandbox image as UID 1000 with writable HOME, /tmp and /workspace mounts.
set -euo pipefail

test "$(id -u)" = 1000
test "$(id -g)" = 1000
qa_dir=$(mktemp -d /workspace/skills-toolchain.XXXXXX)
touch "$HOME/skills-toolchain-home-writable" /tmp/skills-toolchain-tmp-writable
cd "$qa_dir"

test "$(officecli --version)" = 1.0.151
for format in docx pptx xlsx; do officecli help "$format" >/dev/null; done
python3 - <<'PY'
import bs4, docx, json_repair, lxml, pdfplumber, PIL, pypdf, reportlab, requests
import sys
assert sys.prefix == '/opt/power-evolve/venv', sys.prefix
PY
/usr/bin/python3 -c 'import uno'
fc-match 'Noto Sans CJK SC' | grep --fixed-strings 'NotoSansCJK' >/dev/null
kpsewhich pzdr.tfm >/dev/null

python3 - <<'PY'
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont('WenQuanYiZenHei', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'))
page = canvas.Canvas('chinese.pdf')
page.setFont('WenQuanYiZenHei', 16)
page.drawString(72, 720, '中文 PDF 验证')
page.save()
PY
pdftotext chinese.pdf chinese.txt
grep --fixed-strings '中文 PDF 验证' chinese.txt >/dev/null
pdftoppm -f 1 -l 1 -scale-to 512 -singlefile -png chinese.pdf chinese-page >/dev/null 2>&1
test -s chinese-page.png
python3 - <<'PY'
from pypdf import PdfReader
import pdfplumber
assert '中文 PDF 验证' in (PdfReader('chinese.pdf').pages[0].extract_text() or '')
with pdfplumber.open('chinese.pdf') as pdf:
    assert '中文 PDF 验证' in (pdf.pages[0].extract_text() or '')
PY

cat > ctex.tex <<'TEX'
\documentclass[UTF8]{ctexart}
\usepackage{hyperref}
\setCJKmainfont{Noto Serif CJK SC}
\begin{document}
中文 LaTeX 验证。\section{测试}XeLaTeX 和 CTeX 正常工作。
\end{document}
TEX
xelatex -interaction=nonstopmode -halt-on-error ctex.tex >/dev/null
test -s ctex.pdf
pdftotext ctex.pdf latex.txt
grep --fixed-strings '中文 LaTeX 验证' latex.txt >/dev/null

officecli create qa.docx >/dev/null
officecli add qa.docx /body --type paragraph --prop 'text=Document QA' >/dev/null
officecli close qa.docx >/dev/null
officecli validate qa.docx >/dev/null
python3 - <<'PY'
from docx import Document
assert any('Document QA' in paragraph.text for paragraph in Document('qa.docx').paragraphs)
PY

officecli create qa.pptx >/dev/null
officecli add qa.pptx / --type slide --prop 'title=Slide QA' >/dev/null
officecli close qa.pptx >/dev/null
officecli validate qa.pptx >/dev/null
officecli view qa.pptx text | grep --fixed-strings 'Slide QA' >/dev/null

officecli create qa.xlsx >/dev/null
officecli set qa.xlsx /Sheet1/A1 --prop value=42 >/dev/null
officecli close qa.xlsx >/dev/null
officecli validate qa.xlsx >/dev/null
officecli get qa.xlsx /Sheet1/A1 --json | grep --fixed-strings '"text": "42"' >/dev/null

printf 'Pandoc QA\n' > sample.md
pandoc sample.md -o pandoc.docx
python3 - <<'PY'
from docx import Document
assert any('Pandoc QA' in paragraph.text for paragraph in Document('pandoc.docx').paragraphs)
PY
libreoffice -env:UserInstallation="file://$HOME/lo-qa-profile" --headless --convert-to pdf \
  --outdir "$qa_dir" qa.docx >/dev/null
test -s qa.pdf
pdftotext qa.pdf - | grep --fixed-strings 'Document QA' >/dev/null

if command -v javac >/dev/null || command -v mvn >/dev/null || command -v chromium >/dev/null; then
  echo 'Unexpected JDK, Maven or Chromium executable in skills image' >&2
  exit 1
fi
printf 'PASS uid=1000 officecli=1.0.151 python=venv pdf=chinese-extract-render latex=ctex docx=pandoc+officecli+libreoffice pptx=officecli xlsx=officecli home/tmp/workspace=writable\n'
