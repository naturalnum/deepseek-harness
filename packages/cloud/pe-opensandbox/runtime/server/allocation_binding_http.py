"""Read the original Docker identity after create and before Root publishes readiness."""
from __future__ import annotations

import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from opensandbox_server.middleware.auth import SANDBOX_API_KEY_HEADER
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from .deletion_ack_http import MAX_ACK_BODY_BYTES, _error, _read_payload
from .deletion_acknowledgement import SCOPE_FIELDS, _label_hash
from .deletion_completion import CompletionUnknown, ID, SHA, encode, require
from .deletion_terminal_http import TerminalReadCompletionRecords, install_private_deletion_receipts

BINDING_ROUTE = '/v1/sandboxes/{sandbox_id}/deletion-receipt/binding'
CAPABILITY_ROUTE = '/v1/deletion-receipts'


def read_original_running_binding(service, records, key, sid, scope, generation, policy):
    records._authenticate(key)
    require(isinstance(scope, list) and len(scope) == 10
            and all(isinstance(field, str) and field.isascii() and field.isprintable() and 0 < len(field) <= 4096
                    for field in scope), 'allocation-binding-scope')
    with records.original_serial(sid):
        selected = records.get(sid)
        require(selected['phase'] == 'bound' and sid not in records.historical
                and selected['generation'] == generation and selected['policy'] == policy, 'allocation-binding-state')
        records.view.assert_original(selected)
        require(selected['labels']['pe-allocation'] == _label_hash(scope[0].encode('ascii'))
                and selected['labels']['pe-scope'] == _label_hash(encode(scope)), 'allocation-binding-scope')
        # Use the immutable CID from original create, and the same socket/generation
        # previously selected by the original provider. Never search or accept a caller CID.
        container = service.docker_client.containers.get(selected['cid'])
        attrs = container.attrs
        labels = attrs.get('Config', {}).get('Labels') or {}
        state = attrs.get('State') or {}
        require(container.id == selected['cid'] and attrs.get('Id') == selected['cid']
                and state.get('Running') is True and state.get('Paused') is False and state.get('Restarting') is False
                and all(labels.get(name) == value for name, value in selected['labels'].items())
                and labels.get('opensandbox.io/platform-os') == 'linux'
                and not labels.get('opensandbox.io/ossfs-mounts')
                and not labels.get('opensandbox.io/volume-managed-by'), 'allocation-binding-live-original')
        records.view.assert_original(selected)
        return {**dict(zip(SCOPE_FIELDS, scope[:5])), 'sandboxId': sid, 'containerId': selected['cid'],
                'providerGeneration': selected['generation'], 'policyDigest': selected['policy']}


def install_private_allocation_binding(app: FastAPI, service):
    """Register the private receipt routes and original binding read together at startup."""
    records = getattr(service, '_deletion_records', None)
    require(isinstance(records, TerminalReadCompletionRecords), 'allocation-binding-owner')
    require(not any(getattr(route, 'path', None) in (BINDING_ROUTE, CAPABILITY_ROUTE)
                    for route in app.routes), 'allocation-binding-registered')
    install_private_deletion_receipts(app, service)

    async def capability(request: Request):
        key = request.headers.getlist(SANDBOX_API_KEY_HEADER)
        if len(key) != 1 or not key[0].isascii() or not 0 < len(key[0]) <= 4096:
            return _error(401, 'receipt-auth-required')
        if request.url.query:
            return _error(400, 'receipt-invalid')
        try:
            records._authenticate(key[0].encode('ascii'))
            generation = await run_in_threadpool(records.view.assert_generation)
            require(generation == records.generation and records.view.sha == records.policy
                    and records.view.policy.get('admitCreates') is True, 'allocation-binding-state')
        except CompletionUnknown as failure:
            if failure.code == 'ack-auth':
                return _error(401, 'receipt-auth-required')
            return _error(409, 'binding-unconfirmed')
        except OSError:
            return _error(409, 'binding-unconfirmed')
        return JSONResponse({'providerGeneration': generation, 'policyDigest': records.policy}, headers={'Cache-Control': 'no-store'})

    async def read_binding(sandbox_id: str, request: Request):
        key = request.headers.getlist(SANDBOX_API_KEY_HEADER)
        if len(key) != 1 or not key[0].isascii() or not 0 < len(key[0]) <= 4096:
            return _error(401, 'receipt-auth-required')
        if not ID.fullmatch(sandbox_id) or request.url.query:
            return _error(400, 'receipt-invalid')
        media = request.headers.getlist('content-type')
        if len(media) != 1 or media[0].lower() not in ('application/json', 'application/json; charset=utf-8'):
            return _error(415, 'receipt-media-type')
        lengths = request.headers.getlist('content-length')
        if (len(lengths) != 1 or not re.fullmatch(r'[1-9][0-9]{0,4}', lengths[0])
                or request.headers.getlist('transfer-encoding')):
            return _error(400, 'receipt-length')
        size = int(lengths[0])
        if size > MAX_ACK_BODY_BYTES:
            return _error(413, 'receipt-too-large')
        try:
            payload = await _read_payload(request, size)
            require(isinstance(payload, dict) and set(payload) == {'scope', 'providerGeneration', 'policyDigest'},
                    'allocation-binding-payload')
            scope, generation, policy = (payload[name] for name in ('scope', 'providerGeneration', 'policyDigest'))
            require(isinstance(scope, list) and len(scope) == 10
                    and all(isinstance(value, str) and SHA.fullmatch(value) for value in (generation, policy)),
                    'allocation-binding-payload')
        except TimeoutError:
            return _error(408, 'receipt-timeout')
        except (ClientDisconnect, CompletionUnknown, RecursionError, ValueError):
            return _error(400, 'receipt-invalid')
        try:
            result = await run_in_threadpool(read_original_running_binding, service, records,
                                            key[0].encode('ascii'), sandbox_id, scope, generation, policy)
        except CompletionUnknown as failure:
            if failure.code == 'ack-auth':
                return _error(401, 'receipt-auth-required')
            return _error(409, 'binding-unconfirmed')
        except OSError:
            return _error(409, 'binding-unconfirmed')
        return JSONResponse(result, headers={'Cache-Control': 'no-store'})

    app.add_api_route(BINDING_ROUTE, read_binding, methods=['POST'], include_in_schema=False)
    app.add_api_route(CAPABILITY_ROUTE, capability, methods=['GET'], include_in_schema=False)
