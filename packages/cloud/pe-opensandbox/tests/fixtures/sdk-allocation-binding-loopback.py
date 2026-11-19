"""Actual SDK auth and TCP for the live original binding; Docker inspect uses an exact fixture."""
import argparse
import json
import os
from pathlib import Path
import runpy
import socket
from types import SimpleNamespace

import uvicorn

FIXTURES = Path(__file__).resolve().parent
PRIOR = runpy.run_path(str(FIXTURES / 'sdk-terminal-receipt-loopback.py'))
HTTP, SDK, KEY, SID, SCOPE = (PRIOR[key] for key in ('HTTP', 'SDK', 'KEY', 'SID', 'SCOPE'))
RECORD = HTTP['FIXTURE']['original']


def active_inputs(wheel, root):
    auth, terminal = PRIOR['load_runtime'](wheel)
    from original_sdk_server_sources import allocation_binding_http as binding
    owner = terminal.TerminalReadCompletionRecords(root, uid=os.getuid(), require_domain=False,
                                                  view=HTTP['FIXTURE']['OriginalView']())
    return auth, binding, owner


def serve(wheel, root, fd):
    auth, binding, owner = active_inputs(wheel, root)
    app, service = HTTP['fixture_app'](owner, auth)

    def inspect(cid):
        index = int(cid, 16)
        assert index in (3, 4), 'only the two original full CIDs should be inspected'
        with (root.parent / 'inspect-log').open('a') as request:
            request.write(cid + '\n')
        actual = cid if index == 3 else 'f' * 64
        labels = {**RECORD(index)['labels'], 'opensandbox.io/platform-os': 'linux'}
        return SimpleNamespace(id=actual, attrs={'Id': actual, 'Config': {'Labels': labels},
                                                 'State': {'Running': True, 'Paused': False, 'Restarting': False}})
    service.docker_client = SimpleNamespace(containers=SimpleNamespace(get=inspect))
    binding.install_private_allocation_binding(app, service)
    with socket.socket(fileno=fd) as listener:
        assert listener.getsockname()[0] == '127.0.0.1'
        uvicorn.Server(uvicorn.Config(app, access_log=False, log_level='warning')).run(sockets=[listener])


def main(wheel, node):
    http = HTTP['DeletionAckHttp']()
    http.setUp()
    try:
        _, binding, owner = active_inputs(wheel, http.root)
        try:
            for index in (3, 4):
                owner.reserve(RECORD(index))
                owner.bind(SID(index), f'{index:064x}')
        finally:
            owner.close()
        observed = http.root / (SID(3) + '.json')
        before = observed.read_bytes()
        # Reuse the private socket launcher, selecting this test's child entrypoint.
        PRIOR['loopback'].__wrapped__.__globals__['__file__'] = __file__
        with PRIOR['loopback'](http, wheel) as (provider_pid, port):
            generation, policy = (RECORD(3)[key] for key in ('generation', 'policy'))

            def read(index, scope, *, key=KEY, **changes):
                return http.request(port, path=binding.BINDING_ROUTE.format(sandbox_id=SID(index)), key=key,
                                    body=SDK.encode({'scope': scope, 'providerGeneration': generation,
                                                     'policyDigest': policy, **changes}))[0]
            assert read(3, SCOPE(3), key=None) == 401
            assert read(3, SCOPE(4)) == 409
            assert read(3, SCOPE(3), providerGeneration='f' * 64) == 409
            assert read(3, SCOPE(3), policyDigest='f' * 64) == 409
            assert read(3, SCOPE(3), containerId='f' * 64) == 400
            assert read(1, SCOPE(1)) == 409  # completed is not live creation binding
            assert read(4, SCOPE(4)) == 409  # stored CID did not match exact inspect
            scope = SCOPE(3)
            keys = ('allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId', 'environmentVersion',
                    'provider', 'projectMountVersion', 'requestedAt', 'createDeadlineAt')
            (http.work / 'binding-input.json').write_text(json.dumps({
                'intent': dict(zip(keys, scope)), 'sandboxId': SID(3),
                'providerGeneration': generation, 'policyDigest': policy,
            }))
            fresh = json.loads(PRIOR['run_node'](node, 'sdk-allocation-binding-app.mjs', http.work, port))
            assert fresh == {**dict(zip(keys[:5], scope[:5])), 'sandboxId': SID(3), 'containerId': f'{3:064x}',
                             'providerGeneration': generation, 'policyDigest': policy}
            assert observed.read_bytes() == before
            assert (http.work / 'inspect-log').read_text().splitlines() == [f'{4:064x}', f'{3:064x}']
            print(f'Original SDK PID {provider_pid}; real Root SDK transport read exact live Docker binding')
            print('Auth, cross-scope, generation, policy, caller CID and mismatched live CID refusals verified')
    finally:
        http.doCleanups()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--node')
    parser.add_argument('--serve', type=Path)
    parser.add_argument('--socket-fd', type=int)
    args = parser.parse_args()
    if args.serve:
        serve(args.wheel.resolve(), args.serve, args.socket_fd)
    else:
        main(args.wheel.resolve(), args.node)
