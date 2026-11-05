#!/opt/dsh/runtime/dependencies/python/bin/python3
"""Refresh bundled report C/F/T catalogs inside the caller's managed Bash execution."""

import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
from xml.sax.saxutils import escape

from word_catalog import apply_cache, prepare


class Cancelled(Exception):
    """The original execution owner interrupted this operation."""


class UnsettledProcess(Exception):
    """Local quiescence was not confirmed; retain operation files for the original owner."""


class Writer:
    """Own only this invocation's Writer descendants and private profile."""

    def __init__(self, executable, directory, deadline, grace):
        self.executable = executable
        self.directory = directory
        self.deadline = deadline
        self.grace = grace
        self.profile = directory / 'profile'

    def run(self, arguments):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Word refresh deadline expired')
        with (self.directory / 'writer.log').open('ab') as log:
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
            try:
                process = subprocess.Popen(
                    [self.executable, '-env:UserInstallation=' + self.profile.as_uri(),
                     '--headless', '--norestore', '--nodefault', '--nofirststartwizard', *arguments],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                    preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask),
                    env={key: value for key, value in os.environ.items()
                         if re.search(r'KEY|SECRET|TOKEN|PASSWORD', key, re.I) is None})
            except BaseException:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
                raise
            try:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
                if process.wait(timeout=remaining) != 0:
                    raise RuntimeError('Writer exited unsuccessfully')
            finally:
                self.settle(process)

    def settle(self, process):
        handlers = {signum: signal.signal(signum, signal.SIG_IGN)
                    for signum in (signal.SIGTERM, signal.SIGINT)}
        try:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass  # This invocation's process group is already absent.
            try:
                process.wait(timeout=self.grace)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                try:
                    process.wait(timeout=self.grace)
                except subprocess.TimeoutExpired as error:
                    raise UnsettledProcess(str(self.directory)) from error
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                return
            until = time.monotonic() + self.grace
            while time.monotonic() < until:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    return
                time.sleep(min(0.05, max(0, until - time.monotonic())))
            raise UnsettledProcess(str(self.directory))
        except (OSError, subprocess.TimeoutExpired) as error:
            raise UnsettledProcess(str(self.directory)) from error
        finally:
            for signum, handler in handlers.items():
                signal.signal(signum, handler)

    def initialize(self):
        self.run(['--terminate_after_init'])

    def macro(self, source, destination, refresh):
        library = self.profile / 'user/basic/Standard'
        library.mkdir(parents=True, exist_ok=True)
        # URLs and paths become Basic literals, never Basic source supplied by the document.
        def literal(value):
            if any(character in str(value) for character in '\r\n\0'):
                raise ValueError('Unsupported control character in Writer path')
            return '"' + str(value).replace('"', '""') + '"'

        update = '''
For pass = 1 To 2
  doc.refresh()
  For i = 0 To indexes.getCount() - 1
    indexes.getByIndex(i).update()
  Next i
Next pass
fileAccess = CreateUnoService("com.sun.star.ucb.SimpleFileAccess")
For i = 0 To indexes.getCount() - 1
  textStream = CreateUnoService("com.sun.star.io.TextOutputStream")
  textStream.setOutputStream(fileAccess.openFileWrite(ConvertToURL(INDEX_PREFIX & i & ".txt")))
  textStream.setEncoding("UTF-8")
  textStream.writeString(indexes.getByIndex(i).getAnchor().String & Chr(10))
  textStream.closeOutput()
Next i
'''.replace('INDEX_PREFIX', literal(destination / 'index-')) if refresh else ''
        export = '' if refresh else f'''
exported(0).Name = "FilterName"
exported(0).Value = "writer_pdf_Export"
doc.storeToURL({literal((destination / 'report.pdf').as_uri())}, exported())
'''
        macro = f'''Sub Main
On Error GoTo Failed
Dim props(2) As New com.sun.star.beans.PropertyValue
Dim exported(0) As New com.sun.star.beans.PropertyValue
Dim doc As Object, indexes As Object, i As Integer, pass As Integer, outFile As Integer
Dim fileAccess As Object, textStream As Object
props(0).Name = "Hidden"
props(0).Value = True
props(1).Name = "MacroExecutionMode"
props(1).Value = 0
props(2).Name = "UpdateDocMode"
props(2).Value = 0
doc = StarDesktop.loadComponentFromURL({literal(source.as_uri())}, "_blank", 0, props())
indexes = doc.getDocumentIndexes()
{update}
{export}
doc.close(True)
outFile = FreeFile()
Open {literal(destination / 'complete.txt')} For Output As #outFile
Print #outFile, "complete"
Close #outFile
StarDesktop.terminate()
Exit Sub
Failed:
outFile = FreeFile()
Open {literal(destination / 'error.txt')} For Output As #outFile
Print #outFile, Err & ": " & Error$
Close #outFile
On Error Resume Next
doc.close(True)
StarDesktop.terminate()
End Sub
'''
        (library / 'Module1.xba').write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<script:module xmlns:script="http://openoffice.org/2000/script" '
            'script:name="Module1" script:language="StarBasic">'
            + escape(macro) + '</script:module>\n', encoding='utf-8')
        namespace = 'xmlns:library="http://openoffice.org/2000/library"'
        (library / 'script.xlb').write_text(
            f'<library:library {namespace} library:name="Standard" library:readonly="false" '
            'library:passwordprotected="false"><library:element library:name="Module1"/>'
            '</library:library>\n', encoding='utf-8')
        (library.parent / 'script.xlc').write_text(
            f'<library:libraries {namespace} xmlns:xlink="http://www.w3.org/1999/xlink">'
            '<library:library library:name="Standard" library:link="false"/>'
            '</library:libraries>\n', encoding='utf-8')
        self.run(['macro:///Standard.Module1.Main()'])
        if (destination / 'error.txt').exists() or not (destination / 'complete.txt').is_file():
            raise RuntimeError('Writer did not finish the requested catalog operation')


def refresh(source, output, executable, timeout, grace):
    """Publish DOCX/PDF/cache only in a newly reserved directory; never rewrite input."""
    source = source.resolve(strict=True)
    output = output.absolute()
    if not source.is_file():
        raise ValueError('Input must be a DOCX file')
    deadline = time.monotonic() + timeout
    output.mkdir(mode=0o700)  # Existing paths are errors, including symlinks.
    try:
        scratch = Path(tempfile.mkdtemp(prefix='.word-refresh-', dir=output))
    except BaseException:
        output.rmdir()
        raise
    published = []
    previous = {}
    unsettled = False

    def cancel(signum, frame):
        raise Cancelled('Word refresh cancelled')

    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, cancel)
        snapshot = scratch / 'input.docx'
        with source.open('rb') as reader, snapshot.open('xb') as writer:
            shutil.copyfileobj(reader, writer, length=65536)
        prepared = scratch / 'prepared'
        prepare(snapshot, prepared)
        operation = Writer(executable, scratch, deadline, grace)
        operation.initialize()
        calculated = scratch / 'calculated'
        calculated.mkdir()
        operation.macro(prepared / 'native-working.docx', calculated, True)
        apply_cache(prepared, calculated)
        rendered = scratch / 'rendered'
        rendered.mkdir()
        operation.macro(prepared / 'final.docx', rendered, False)
        with (rendered / 'report.pdf').open('rb') as reader:
            if reader.read(5) != b'%PDF-':
                raise ValueError('Writer did not produce a PDF')
        if time.monotonic() >= deadline:
            raise TimeoutError('Word refresh deadline expired before publication')
        for path, name in [(prepared / 'final.docx', 'report.docx'),
                           (rendered / 'report.pdf', 'report.pdf'),
                           (prepared / 'cache.json', 'catalogs.json')]:
            os.link(path, output / name)
            published.append(output / name)
    except UnsettledProcess:
        unsettled = True
        raise
    except BaseException:
        for path in published:
            path.unlink()
        published.clear()
        raise
    finally:
        # Writer.run settles its local child group first; the enclosing Bash owner retains
        # responsibility for the managed environment and any unconfirmed process release.
        for signum, handler in previous.items():
            signal.signal(signum, signal.SIG_IGN)
        if not unsettled:
            shutil.rmtree(scratch)
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        if not published and not unsettled:
            output.rmdir()
    return {'docx': str(output / 'report.docx'), 'pdf': str(output / 'report.pdf'),
            'catalogs': str(output / 'catalogs.json')}


def positive(value):
    """Parse explicit finite operation timing without changing execution-owner limits."""
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise argparse.ArgumentTypeError('Expected a positive finite number')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path, help='New directory; existing paths are rejected')
    parser.add_argument('--soffice', required=True, type=Path)
    parser.add_argument('--timeout-seconds', required=True, type=positive)
    parser.add_argument('--cancel-grace-seconds', required=True, type=positive)
    args = parser.parse_args()
    if not args.soffice.is_absolute():
        parser.error('--soffice must be absolute')
    print(json.dumps(refresh(args.source, args.output, str(args.soffice),
                             args.timeout_seconds, args.cancel_grace_seconds)))
