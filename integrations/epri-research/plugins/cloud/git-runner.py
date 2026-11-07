"""Run Git inside the existing managed Python process group with bounded pipes."""
import json
import os
import selectors
import subprocess
import sys

request = json.load(sys.stdin)
script = os.path.abspath(__file__)
if not os.path.basename(script).startswith('.research-') or not script.endswith('.py'):
    raise ValueError('Invalid staged Git script')
# runpy has compiled this exact script; neither file belongs to the user's working tree.
os.unlink(script)
os.unlink(script[:-3] + '-bootstrap.py')

limit = request['maxPayloadBytes']
process = None
selector = selectors.DefaultSelector()
streams = {'stdout': bytearray(), 'stderr': bytearray()}
observed = 0
try:
    process = subprocess.Popen(
        [request['gitPath'], '--no-pager', '-c', 'core.quotepath=false',
         '-c', 'core.fsmonitor=false', *request['args']],
        cwd=request['path'], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    for name, stream in (('stdout', process.stdout), ('stderr', process.stderr)):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, name)
    while selector.get_map():
        for key, _ in selector.select():
            chunk = os.read(key.fd, min(65536, limit - observed + 1))
            if not chunk:
                selector.unregister(key.fileobj)
                key.fileobj.close()
                continue
            observed += len(chunk)
            if observed > limit:
                raise ValueError('Git output exceeds configured payload capacity')
            streams[key.data].extend(chunk)
    code = process.wait()
    result = json.dumps({'exitCode': code,
                         'stdout': streams['stdout'].decode('utf8', errors='replace'),
                         'stderr': streams['stderr'].decode('utf8', errors='replace')},
                        ensure_ascii=False, separators=(',', ':'))
    if len(result.encode('utf8')) > limit:
        raise ValueError('Git result exceeds configured payload capacity')
    print(result)
finally:
    selector.close()
    if process is not None:
        if process.poll() is None:
            process.kill()
        # The original managed range still owns descendants and confirms their exit.
        process.wait(timeout=request['graceMs'] / 1000)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()
