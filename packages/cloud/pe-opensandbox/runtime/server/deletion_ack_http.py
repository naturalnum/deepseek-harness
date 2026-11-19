"""Private ACK route for the selected, already authenticated OpenSandbox service."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from opensandbox_server.middleware.auth import AuthMiddleware, SANDBOX_API_KEY_HEADER
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from .deletion_acknowledgement import AcknowledgedCompletionRecords
from .deletion_completion import CompletionUnknown, ID, pairs_unique, require

ACK_ROUTE = '/v1/sandboxes/{sandbox_id}/deletion-receipt/ack'
MAX_ACK_BODY_BYTES = 65536
ACK_BODY_TIMEOUT_SECONDS = 2


def _error(status: int, code: str):
    return JSONResponse({'code': code}, status_code=status, headers={'Cache-Control': 'no-store'})


async def _read_payload(request, content_length):
    raw = bytearray()
    async with asyncio.timeout(ACK_BODY_TIMEOUT_SECONDS):
        async for chunk in request.stream():
            require(len(raw) + len(chunk) <= content_length, 'ack-http-length')
            raw.extend(chunk)
    require(len(raw) == content_length, 'ack-http-length')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs_unique)


def install_private_deletion_ack(app: FastAPI, service):
    """Register only on the original single-tenant Root control app before startup."""
    records = getattr(service, '_deletion_records', None)
    require(isinstance(records, AcknowledgedCompletionRecords)
            and getattr(service, '_deletion_view', None) is records.view, 'ack-http-owner')
    config = app.state.config
    auth = [entry for entry in app.user_middleware if entry.cls is AuthMiddleware]
    require(config is service.app_config and getattr(app.state, 'tenant_provider', False) is None
            and len(auth) == 1 and auth[0].kwargs.get('config') is config
            and auth[0].kwargs.get('tenant_provider') is None, 'ack-http-auth-owner')
    require(not any(getattr(route, 'path', None) == ACK_ROUTE for route in app.routes), 'ack-http-registered')
    original_key = config.server.api_key
    require(isinstance(original_key, str) and original_key.isascii() and 0 < len(original_key) <= 4096
            and hmac.compare_digest(hashlib.sha256(original_key.encode('ascii')).hexdigest(), records.key_sha),
            'ack-http-auth-owner')

    async def acknowledge(sandbox_id: str, request: Request):
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
            require(isinstance(payload, dict) and set(payload) == {'scope', 'receipt'}, 'ack-http-payload')
            scope, receipt = payload['scope'], payload['receipt']
            require(isinstance(scope, list) and len(scope) == 10 and isinstance(receipt, dict)
                    and receipt.get('sandboxId') == sandbox_id, 'ack-http-binding')
        except TimeoutError:
            return _error(408, 'receipt-timeout')
        except (ClientDisconnect, CompletionUnknown, RecursionError, ValueError):
            return _error(400, 'receipt-invalid')
        try:
            result = await run_in_threadpool(records.acknowledge, key[0].encode('ascii'), scope, receipt)
        except CompletionUnknown as failure:
            if failure.code == 'ack-auth':
                return _error(401, 'receipt-auth-required')
            return _error(409, 'receipt-unconfirmed')
        except OSError:
            return _error(409, 'receipt-unconfirmed')
        return JSONResponse(result, headers={'Cache-Control': 'no-store'})

    app.add_api_route(ACK_ROUTE, acknowledge, methods=['POST'], include_in_schema=False)
