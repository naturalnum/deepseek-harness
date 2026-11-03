#!/usr/bin/env python3
"""Require a visible native Word equation in an explicitly selected disposable guest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import subprocess

from docx import Document
from docx.oxml import OxmlElement


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--soffice', required=True)
    parser.add_argument('--pdftotext', required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    args = parser.parse_args()
    output = args.output_directory.resolve()
    output.mkdir(parents=True, exist_ok=False)
    profile = output / 'profile'
    pdf_directory = output / 'pdf'
    pdf_directory.mkdir()
    document = Document()
    document.add_paragraph('Native equation visibility probe')
    equation = OxmlElement('m:oMath')
    for token in ['P', '=', 'U', 'I']:
        run = OxmlElement('m:r')
        text = OxmlElement('m:t')
        text.text = token
        run.append(text)
        equation.append(run)
    document.add_paragraph()._p.append(equation)
    source = output / 'equation.docx'
    document.save(source)

    def limits():
        resource.setrlimit(resource.RLIMIT_AS, (536870912, 536870912))
        resource.setrlimit(resource.RLIMIT_FSIZE, (67108864, 67108864))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    env = dict(os.environ, MALLOC_ARENA_MAX='1', SAL_USE_VCLPLUGIN='svp',
               OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1')
    result = subprocess.run([args.soffice, '-env:UserInstallation=' + profile.as_uri(),
        '--headless', '--norestore', '--nodefault', '--nofirststartwizard', '--convert-to',
        'pdf', '--outdir', str(pdf_directory), str(source)], env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, preexec_fn=limits, timeout=60)
    (output / 'convert.log').write_bytes(result.stdout)
    if result.returncode != 0:
        raise RuntimeError('Native Word equation conversion failed')
    pdf = pdf_directory / 'equation.pdf'
    if not pdf.is_file() or pdf.stat().st_size == 0:
        raise RuntimeError('Native Word equation conversion produced no PDF')
    text = subprocess.run([args.pdftotext, str(pdf), '-'], env=env, check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=limits, timeout=30)
    (output / 'pdf-text.txt').write_bytes(text.stdout)
    visible = 'P=UI' in re.sub(r'\s+', '', text.stdout.decode('utf-8'))
    record = {'equationVisibleInPdf': visible,
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'pdfSha256': hashlib.sha256(pdf.read_bytes()).hexdigest(),
        'limits': {name: Path('/sys/fs/cgroup/' + name).read_text().strip()
                   for name in ['cpu.max', 'memory.max', 'pids.max', 'memory.events']},
        'addressSpaceBytes': 536870912,
        'qualification': 'Disposable selected guest only; not authenticated account/model acceptance'}
    (output / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    if not visible:
        raise RuntimeError('Native Word equation is present in DOCX but absent from rendered PDF')


if __name__ == '__main__':
    main()
