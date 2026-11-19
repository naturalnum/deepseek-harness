"""Read the positively completed original receipt on the selected private SDK app."""
from __future__ import annotations

from contextvars import ContextVar
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from opensandbox_server.middleware.auth import SANDBOX_API_KEY_HEADER
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from .deletion_ack_http import MAX_ACK_BODY_BYTES, _error, _read_payload, install_private_deletion_ack
from .deletion_acknowledgement import AcknowledgedCompletionRecords
from .deletion_completion import CompletionUnknown, ID, SHA, require

TERMINAL_ROUTE = '/v1/sandboxes/{sandbox_id}/deletion-receipt'
IDENTITY = frozenset(('sandboxId', 'containerId', 'providerGeneration', 'policyDigest'))
_reading_terminal = ContextVar('reading_terminal_receipt', default=False)


def _exact_expected(sid, expected):
    return (
        isinstance(expected, dict) and expected.keys() in (IDENTITY, IDENTITY | {'receiptDigest'})
        and expected['sandboxId'] == sid
        and all(isinstance(value, str) and SHA.fullmatch(value)
                for field, value in expected.items() if field != 'sandboxId')
    )


class TerminalReadCompletionRecords(AcknowledgedCompletionRecords):
    """Reuse original completion checks without retiring outstanding active evidence on a terminal read."""

    def _retire(self, sid):
        if not _reading_terminal.get():
            super()._retire(sid)

    def read_terminal_receipt(self, key, sid, scope, expected):
        require(_exact_expected(sid, expected), 'terminal-binding')
        token = _reading_terminal.set(True)
        try:
            result = self.completed_receipt(key, sid, scope)
            require(all(result.get(field) == value for field, value in expected.items()), 'terminal-binding')
            return result
        finally:
            _reading_terminal.reset(token)


def install_private_deletion_receipts(app: FastAPI, service):
    """Install the versioned read and ACK together, using the original ACK authentication gate."""
    records = getattr(service, '_deletion_records', None)
    require(isinstance(records, TerminalReadCompletionRecords), 'terminal-http-owner')
    require(not any(getattr(route, 'path', None) == TERMINAL_ROUTE for route in app.routes), 'terminal-http-registered')
    install_private_deletion_ack(app, service)

    async def terminal(sandbox_id: str, request: Request):
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
            require(isinstance(payload, dict) and set(payload) == {'scope', 'expected'}, 'terminal-http-payload')
            scope, expected = payload['scope'], payload['expected']
            require(isinstance(scope, list) and len(scope) == 10 and _exact_expected(sandbox_id, expected), 'terminal-http-binding')
        except TimeoutError:
            return _error(408, 'receipt-timeout')
        except (ClientDisconnect, CompletionUnknown, RecursionError, ValueError):
            return _error(400, 'receipt-invalid')
        try:
            result = await run_in_threadpool(records.read_terminal_receipt, key[0].encode('ascii'), sandbox_id, scope, expected)
        except CompletionUnknown as failure:
            if failure.code == 'ack-auth':
                return _error(401, 'receipt-auth-required')
            return _error(409, 'receipt-unconfirmed')
        except OSError:
            return _error(409, 'receipt-unconfirmed')
        return JSONResponse(result, headers={'Cache-Control': 'no-store'})

    app.add_api_route(TERMINAL_ROUTE, terminal, methods=['POST'], include_in_schema=False)
