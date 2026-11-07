"""Test actual bounded child I/O and settlement with a stdlib-only child, never science imports or Docker."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'src/server/document-native.py'
WORKER = '''import json,sys,time
assert sys.argv[1:] == ['--image-child']
payload=json.load(sys.stdin)
mode=payload['mode']
if mode=='stdout': sys.stdout.write('x'*(8*1024*1024+1));sys.stdout.flush()
elif mode=='stderr': sys.stderr.write('x'*32769);sys.stderr.flush()
elif mode=='wait': time.sleep(10)
elif mode=='fail': print('original child failure',file=sys.stderr);sys.exit(9)
else: print(json.dumps({'pages':[{'page':1,'method':'ocr','text':payload.get('text','exact')}]}))
'''


class ChildOwnershipTests(unittest.TestCase):
    def setup_module(self, root):
        spec=importlib.util.spec_from_file_location('candidate_document',SOURCE)
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        worker=root/'worker.py';worker.write_text(WORKER)
        module.__file__=str(worker)
        return module

    def invoke(self, mode, force_timeout=False):
        with tempfile.TemporaryDirectory() as directory:
            module=self.setup_module(Path(directory))
            original=subprocess.Popen
            processes=[]
            baseline=set(threading.enumerate())
            def tracked(*args,**kwargs):
                self.assertNotIn('start_new_session',kwargs)
                self.assertTrue(all(process.poll() is not None for process in processes))
                process=original(*args,**kwargs);processes.append(process)
                wait=process.wait
                def observed_wait(timeout=None):
                    if timeout is not None:
                        self.assertEqual(timeout,60)
                        if force_timeout: raise subprocess.TimeoutExpired(process.args,timeout)
                    return wait(timeout=timeout)
                process.wait=observed_wait
                return process
            with patch('subprocess.Popen',side_effect=tracked):
                if mode=='echo':
                    self.assertEqual(module._run_image_child({'mode':mode,'text':'实际文本42'}),'实际文本42')
                    self.assertEqual(module._run_image_child({'mode':mode,'text':'second page'}),'second page')
                elif force_timeout:
                    with self.assertRaisesRegex(TimeoutError,'60 seconds'):module._run_image_child({'mode':mode})
                else:
                    with self.assertRaises(RuntimeError):module._run_image_child({'mode':mode})
            self.assertTrue(processes)
            self.assertTrue(all(process.poll() is not None for process in processes))
            self.assertEqual(set(threading.enumerate()),baseline,'Every pipe worker must join before return')
            self.assertTrue(all(stream.closed for process in processes for stream in [process.stdin,process.stdout,process.stderr]))

    def test_loading_source_defers_all_scientific_libraries(self):
        code="import json,runpy,sys;runpy.run_path(sys.argv[1]);print(json.dumps({name:name in sys.modules for name in ['pymupdf','numpy','PIL','rapidocr','onnxruntime']}))"
        result=subprocess.run([sys.executable,'-I','-B','-c',code,str(SOURCE)],capture_output=True,text=True,check=True)
        self.assertEqual(json.loads(result.stdout),{name:False for name in ['pymupdf','numpy','PIL','rapidocr','onnxruntime']})

    def test_internal_image_entry_refuses_pdf_before_importing_heavy_libraries(self):
        result=subprocess.run([sys.executable,'-I','-B',str(SOURCE),'--image-child'],
                              input=json.dumps({'extension':'.pdf','language':'eng','contentBase64':''}),capture_output=True,text=True)
        self.assertEqual(result.returncode,1)
        self.assertIn('Internal image child does not accept PDF input',result.stderr)

    def test_exact_text_sequential_children_and_join(self):self.invoke('echo')
    def test_stdout_overflow_stops_and_joins(self):self.invoke('stdout')
    def test_stderr_overflow_stops_and_joins(self):self.invoke('stderr')
    def test_nonzero_preserves_failure_and_joins(self):self.invoke('fail')
    def test_timeout_kills_and_joins_before_return(self):self.invoke('wait',True)
    def test_input_capacity_refuses_before_spawning(self):
        with tempfile.TemporaryDirectory() as directory:
            module=self.setup_module(Path(directory))
            with patch('subprocess.Popen') as spawn:
                with self.assertRaisesRegex(ValueError,'8 MiB'):module._run_image_child({'text':'x'*(8*1024*1024)})
                spawn.assert_not_called()


if __name__=='__main__':unittest.main(verbosity=2)
