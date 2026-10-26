"""Single-owner in-image records. Allocation/Session/epoch authority stays outside this module."""
import time

from paths import checked_cwd
from wire import LIMITS, ROLES, VERSION, Refused, canonical, collect, request, require, verify_role


class Manager:
    def __init__(self, runtime, owner, mounts, image, role_token, clock=time.monotonic):
        self.runtime, self.owner, self.mounts, self.image, self.clock = runtime, owner, mounts, image, clock
        self.records, self.sealed, self.seal_reason = {}, False, None
        self.pins, self.control_unknown = {}, False
        self.started = clock()
        self.role_token = role_token

    def envelope(self, **values):
        return {'protocolVersion': VERSION, 'runtimeIdentity': self.runtime, **values}

    def existing(self, body):
        row = self.records.get(body['operationId'])
        if row is not None:
            require(row['hash'] == body['specHash'] and row['authorization'] == body['authorization'],
                    'operation_conflict', 409)
        return row

    def register(self, body):
        require(not self.sealed, 'admission_closed', 409)
        require(len(self.records) < 4, 'operation_capacity', 429)
        row = {'id': body['operationId'], 'hash': body['specHash'],
               'authorization': dict(body['authorization']), 'kernel': None, 'closed': False,
               'commitAttempted': False, 'preparedAt': None, 'stopAt': None, 'unknown': False,
               'failure': None, 'cleanupFailure': None, 'cause': None}
        self.records[row['id']] = row  # Persistent for this physical lifetime; never popped or reused.
        return row

    def active_rows(self):
        return [r for r in self.records.values() if r['unknown'] or
                (r['kernel'] is not None and r['kernel'].attempted and not r['kernel'].released)]

    @staticmethod
    def error(error, phase):
        return {'type': type(error).__name__, 'errno': getattr(error, 'errno', None), 'phase': phase}

    def stop_row(self, row, reason, kill):
        row['closed'] = True
        op = row['kernel']
        if op is None or not op.attempted:
            row['cause'] = row['cause'] or reason
            return
        if op.released or op.empty_confirmed:
            return
        row['cause'] = row['cause'] or op.cause or reason
        row['stopAt'] = row['stopAt'] if row['stopAt'] is not None else self.clock()
        try:
            op.stop(row['cause'], kill=kill)
        except Exception as error:
            row['cleanupFailure'] = row['cleanupFailure'] or self.error(error, 'stop')
            row['unknown'], self.sealed, self.seal_reason = True, True, 'stop_unknown'

    def seal(self, reason):
        self.sealed, self.seal_reason, self.owner.closed = True, self.seal_reason or reason, True
        for row in self.records.values():
            self.stop_row(row, reason, kill=True)

    def tick(self):
        now = self.clock()
        if now - self.started >= LIMITS['residentMs'] / 1000 and not self.sealed:
            self.seal('resident-deadline')
        for row in self.records.values():
            op = row['kernel']
            if op is None or not op.attempted or op.released:
                continue
            try:
                if not op.prepared and row['failure'] is None:
                    if op.advance_prepare():
                        row['preparedAt'] = self.clock()
                else:
                    op.pump(timeout=0)
                if op.fault:
                    self.seal('provider-failure')
                if op.empty():
                    op.finish()  # Already empty: close/release only, no blocking stop wait.
                    continue
                if not op.committed and row['preparedAt'] is not None and now - row['preparedAt'] >= LIMITS['preparedLeaseMs'] / 1000:
                    self.stop_row(row, 'prepare-lease-expired', kill=False)
                if op.committed and op.deadline is not None and now >= op.deadline:
                    self.stop_row(row, 'run-deadline', kill=True)
                if op.cause:
                    row['cause'] = row['cause'] or op.cause
                    row['closed'] = True
                    row['stopAt'] = now if row['stopAt'] is None else row['stopAt']
                if row['stopAt'] is not None and now - row['stopAt'] >= LIMITS['stopMs'] / 1000:
                    row['unknown'], self.sealed, self.seal_reason, self.owner.closed = True, True, 'stop_unknown', True
            except Exception as error:
                row['failure'] = row['failure'] or self.error(error, op.phase)
                row['unknown'], self.sealed, self.seal_reason, self.owner.closed = True, True, 'provider_unknown', True
                self.stop_row(row, 'provider-failure', kill=True)

    def snapshot(self, row, offsets=(0, 0)):
        op = row['kernel']
        started = op is not None and op.attempted
        empty = not started or op.released
        result = op.result() if op is not None and op.released else None
        failure = (op.failure if op is not None else None) or row['failure']
        streams = {}
        for name, position in zip(['stdout', 'stderr'], offsets):
            streams[name] = collect(op.counts[name] if op else 0, op.buffers[name] if op else b'',
                                    position, not started or name in op.eof)
        return {'operationId': row['id'], 'specHash': row['hash'],
                'role': row['authorization']['role'], 'registrationId': row['authorization']['registrationId'],
                'primitiveStarted': started,
                'prepared': bool(op and op.prepared), 'commitAttempted': row['commitAttempted'],
                'commitClosed': row['closed'] or self.sealed, 'submitted': bool(op and op.committed),
                'firstCause': (op.cause if op else None) or row['cause'], 'direct': op.direct if op else None,
                'directNotObserved': not bool(op and op.direct), 'rangeEmpty': empty, 'ioClosed': empty,
                'physicalStopRequired': self.control_unknown or any(r['unknown'] for r in self.records.values()),
                'failure': failure, 'cleanupFailure': row['cleanupFailure'],
                'providerFailure': bool(row['failure'] or row['cleanupFailure'] or (op and op.fault)
                                        or (result and result['providerFailure'])),
                'streams': streams}

    def handshake(self):
        active = self.active_rows()
        return {'capabilities': ['argv', 'stdin-ignore', 'stdin-batch', 'collect'], 'pins': self.pins,
                'declaredImageId': self.image, 'mounts': self.mounts,
                'rangeRoles': {role: sum(r['authorization']['role'] == role for r in active) for role in ROLES},
                'limits': dict(LIMITS),
                'newOperationsAccepted': not self.sealed and len(self.records) < 4,
                'recordCount': len(self.records), 'activeRangeCount': len(active),
                'sealed': self.sealed, 'sealReason': self.seal_reason,
                'physicalStopRequired': self.control_unknown or any(r['unknown'] for r in self.records.values())}

    def handle(self, path, body):
        request(path, body, self.runtime)
        if path not in ['/handshake', '/seal']:
            verify_role(body, self.role_token)
        self.tick()
        if path == '/handshake':
            return self.envelope(**self.handshake())
        if path == '/seal':
            self.seal('owner-seal')
            return self.envelope(**self.handshake())
        row = self.existing(body)
        if path == '/prepare':
            if row is None:
                spec, batch, _ = canonical(body['spec'])
                try:
                    checked_cwd(self.owner.project, spec['cwd'])
                except ValueError:
                    raise Refused(400, 'cwd_outside_project') from None
                active = self.active_rows()
                require(len(active) < 2, 'range_busy', 409)
                require(not any(r['authorization']['role'] == body['authorization']['role'] for r in active),
                        'role_busy', 409)
                row = self.register(body)
                try:
                    row['kernel'] = self.owner.register(row['id'], spec['argv'], spec['cwd'], spec['stdin']['mode'],
                                                        batch, role=row['authorization']['role'], working_copies=body.get('skillWorld'))
                    row['kernel'].begin_prepare()
                except Exception as error:
                    row['failure'] = self.error(error, row['kernel'].phase if row['kernel'] else 'register')
                    self.seal('prepare-failure')
                    if row['kernel'] is not None and row['kernel'].attempted:
                        row['unknown'] = True  # Never erase setup responsibility just because its reply failed.
            return self.envelope(operation=self.snapshot(row))
        if path in ['/cancel', '/stop']:
            row = row if row is not None else self.register(body)
            self.stop_row(row, 'cancel' if path == '/cancel' else 'owner-stop',
                          kill=path == '/stop' or bool(row['kernel'] and row['kernel'].committed))
            return self.envelope(operation=self.snapshot(row))
        require(row is not None, 'operation_unknown', 404)
        if path == '/commit':
            if not row['commitAttempted']:
                require(not self.sealed and not row['closed'], 'commit_closed', 409)
                require(row['kernel'] is not None and row['kernel'].prepared, 'not_prepared', 409)
                row['commitAttempted'] = True  # Before the sole kernel C-write attempt, never reset.
                try:
                    row['kernel'].commit(self.started + LIMITS['residentMs'] / 1000)
                except Exception as error:
                    row['failure'] = self.error(error, 'commit')
                    self.seal('commit-uncertain')
            return self.envelope(operation=self.snapshot(row))
        return self.envelope(operation=self.snapshot(row, (body['stdoutOffset'], body['stderrOffset'])))
