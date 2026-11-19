"""Private SDK HTTP fixture for the actual Root composition; no Docker daemon or deployment credentials."""
import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import runpy
import socket
from types import SimpleNamespace
from uuid import uuid4

from fastapi import Request, Response
from fastapi.responses import JSONResponse
import uvicorn

HERE = Path(__file__).resolve().parent
HTTP = runpy.run_path(str(HERE.parent / 'test_deletion_ack_http.py'))
SDK = HTTP['SDK']
FIXTURE = HTTP['FIXTURE']


def serve(wheel, root):
    auth = HTTP['load_auth_and_route'](wheel)
    from original_sdk_server_sources.allocation_binding_http import install_private_allocation_binding
    from original_sdk_server_sources.deletion_terminal_http import TerminalReadCompletionRecords

    work = root / 'work'
    work.mkdir(mode=0o700)
    active = work / 'deletion-completions'
    FIXTURE['ack'].initialize_ack_domain(active, FIXTURE['GENERATION'], FIXTURE['POLICY'], uid=os.getuid())
    view = FIXTURE['OriginalView']()
    view.policy['admitCreates'] = True
    records = TerminalReadCompletionRecords(active, uid=os.getuid(), require_domain=False, view=view)
    app, service = HTTP['fixture_app'](records, auth)
    live = {}
    deferred_deletes = set()

    async def wait_original_delete(sid):
        for _ in range(200):
            decision = root / 'finish-original'
            if decision.is_file() and decision.read_text().strip() == sid:
                SDK.finish_original_delete(service, sid)
                return
            await asyncio.sleep(0.025)

    def inspect(cid):
        item = live.get(cid)
        if item is None:
            raise FileNotFoundError('fixture original no longer live')
        labels = {'opensandbox.io/id': item['id'], **item['metadata'], 'opensandbox.io/platform-os': 'linux'}
        return SimpleNamespace(id=cid, attrs={'Id': cid, 'State': {'Running': True, 'Paused': False, 'Restarting': False},
                                             'Config': {'Labels': labels}})

    def remove(sid, *, expected_container_id):
        assert live[expected_container_id]['id'] == sid
        del live[expected_container_id]
        with (root / 'removes').open('a') as log:
            log.write(sid + '\n')

    service.docker_client = SimpleNamespace(containers=SimpleNamespace(get=inspect))
    service._delete_sandbox_without_completion = remove
    install_private_allocation_binding(app, service)

    @app.post('/v1/sandboxes')
    async def original_create(request: Request):
        body = await request.json()
        sid = str(uuid4())
        cid = hashlib.sha256(sid.encode()).hexdigest()
        now = datetime.now(timezone.utc)
        expires = (now + timedelta(seconds=120)).isoformat()
        labels = {'opensandbox.io/id': sid, **body['metadata']}
        record = SDK.binding(sid, view.generation, view.sha, labels, '8')
        records.reserve(record)
        records.bind(sid, cid)
        info = {'id': sid, 'status': {'state': 'Running'}, 'metadata': body['metadata'], 'image': body['image'],
                'entrypoint': body['entrypoint'], 'createdAt': now.isoformat(), 'expiresAt': expires}
        live[cid] = info
        return JSONResponse(info, status_code=202)

    @app.get('/v1/sandboxes/{sid}')
    async def original_get(sid: str):
        record = records.get(sid)
        if record['cid'] not in live:
            return JSONResponse({'code': 'not-found'}, status_code=404)
        return live[record['cid']]

    @app.delete('/v1/sandboxes/{sid}')
    async def original_delete(sid: str):
        with (root / 'deletes').open('a') as log:
            log.write(sid + '\n')
        if not (root / 'suppress-terminal').exists():
            SDK.finish_original_delete(service, sid)
        elif (root / 'enable-original-finish').exists():
            pending = asyncio.create_task(wait_original_delete(sid))
            deferred_deletes.add(pending)
            pending.add_done_callback(deferred_deletes.discard)
        return Response(status_code=204)

    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(16)
        (root / 'sdk-port').write_text(str(listener.getsockname()[1]))
        uvicorn.Server(uvicorn.Config(app, access_log=False, log_level='warning')).run(sockets=[listener])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    assert args.root.is_dir() and args.root.stat().st_uid == os.getuid() and args.root.stat().st_mode & 0o777 == 0o700
    serve(args.wheel.resolve(), args.root)
