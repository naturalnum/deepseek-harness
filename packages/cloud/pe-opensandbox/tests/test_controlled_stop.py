"""Synthetic admitted-kernel components: real stop/pump/empty/finish and Manager snapshots; no Linux execution."""
import json
import os
from pathlib import Path
import signal
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, os.environ.get('S4_LAUNCHER_ROOT', str(Path(__file__).resolve().parents[1] / 'runtime/agent')))
import launcher
from manager import Manager


class Selector:
    def __init__(self, world, streams):
        self.world, self.streams, self.closed, self.fail_close = world, dict(streams), False, False

    def select(self, _timeout):
        return [(SimpleNamespace(fd=fd, data=name), 1) for fd, name in self.streams.items()
                if self.world.reads.get(fd)]

    def unregister(self, fd):
        del self.streams[fd]

    def close(self):
        if self.fail_close:
            raise OSError('synthetic selector close failure')
        assert not self.streams
        self.closed = True


class World:
    """Only nondeterministic kernel observations are replaced; completion facts run through original methods."""
    def __init__(self):
        self.now, self.gone, self.reads, self.closed, self.signals = 100.0, set(), {}, [], []
        self.close_failure = self.signal_failure = None
        self.owner = SimpleNamespace(project='/project', roots={}, slots={}, closed=False)
        self.manager = Manager('2' * 64, self.owner, {}, 'synthetic-image', '3' * 64, clock=lambda: self.now)
        self.patches = [patch.object(launcher, 'exited', lambda fd: fd in self.gone),
                        patch.object(launcher.signal, 'pidfd_send_signal', self.send, create=True),
                        patch.object(launcher.os, 'close', self.close),
                        patch.object(launcher.os, 'read', lambda fd, _size: self.reads[fd].pop(0)),
                        patch.object(launcher.os, 'set_blocking', lambda *_: None),
                        patch.object(launcher.os, 'fpathconf', lambda *_: 4096),
                        patch.object(launcher.os, 'write', lambda _fd, data: len(data)),
                        patch.object(launcher.time, 'monotonic', lambda: self.now)]

    def __enter__(self):
        for item in self.patches:
            item.start()
        return self

    def __exit__(self, *_):
        for item in reversed(self.patches):
            item.stop()

    def send(self, fd, sig):
        self.signals.append((fd, sig))
        if self.signal_failure is not None:
            raise self.signal_failure

    def close(self, fd):
        self.closed.append(fd)
        if fd == self.close_failure:
            raise OSError('synthetic fd close failure')

    def admitted(self, role, number):
        op = launcher.Operation(self.owner, role, ['/bin/synthetic'], '/project', 'ignore', b'', role)
        self.owner.slots[role] = op
        # Synthetic initial state is immediately after trusted preparation, before original commit.
        op.pidfd, op.gate = number * 100, number * 100 + 1
        streams = {number * 100 + i + 2: name for i, name in enumerate(op.buffers)}
        op.fds.update([op.pidfd, op.gate, *streams])
        op.selector = Selector(self, streams)
        op.process = SimpleNamespace(returncode=None)
        op.process.poll = lambda: op.process.returncode
        op.attempted = op.prepared = True
        row = self.manager.register({'operationId': role, 'specHash': '4' * 64,
                                     'authorization': {'role': role, 'registrationId': 'service-original' if role == 'service' else None,
                                                       'signature': '5' * 64}})
        row['kernel'], row['preparedAt'] = op, self.now
        return op, row

    def commit(self, op, row):
        row['commitAttempted'] = True
        op.commit(self.manager.started + launcher.LIMITS['residentMs'] / 1000)

    def terminate(self, op, *, namespace=True, wrapper=True, omitted=()):
        if namespace:
            self.gone.add(op.pidfd)
        if wrapper:
            op.process.returncode = -9  # Wrapper-only observation, never a DIRECT record.
        for fd, name in op.selector.streams.items():
            if name not in omitted:
                self.reads[fd] = [b'']


def scenario(kind='controlled'):
    with World() as w:
        service, row = w.admitted('service', 1)
        foreground, front = w.admitted('foreground', 2)
        result = {'prepared': w.manager.snapshot(row)}
        w.commit(service, row); w.commit(foreground, front)
        result['live'] = w.manager.snapshot(row)
        if kind != 'uncontrolled':
            w.manager.stop_row(row, 'owner-stop', True)
        result['stopping'] = w.manager.snapshot(row)
        w.terminate(service, namespace=kind != 'namespace-gap', omitted=('stderr',) if kind == 'eof-gap' else ())
        if kind == 'fault':
            service.fault = 'guardian-stage-4-errno-5'
            service.failure = {'type': 'GuardianErrorRecord', 'errno': 5, 'phase': 'guardian-stage-4'}
        if kind == 'fd-close':
            w.close_failure = service.pidfd
        if kind == 'selector-close':
            service.selector.fail_close = True
        w.manager.tick()
        result['afterDrain'] = w.manager.snapshot(row)
        if kind in ['namespace-gap', 'eof-gap']:
            w.now += launcher.LIMITS['stopMs'] / 1000 + 0.01
            w.manager.tick()
        result['terminal'] = w.manager.snapshot(row)
        result['foreground'] = w.manager.snapshot(front)
        result['proof'] = {'signals': w.signals, 'closed': w.closed, 'selectorClosed': service.selector.closed,
                           'remainingFds': sorted(service.fds), 'released': service.released,
                           'controlledStop': getattr(service, 'controlled_stop', False), 'pidfd': service.pidfd,
                           'foregroundPidfd': foreground.pidfd, 'foregroundReleased': foreground.released,
                           'result': service.result()}
        return result


class ControlledStopTests(unittest.TestCase):
    def test_controlled_stop_closes_only_original_range_without_inventing_direct(self):
        value = scenario()
        self.assertEqual(value['proof']['signals'], [(100, signal.SIGKILL)])
        self.assertEqual(sorted(value['proof']['closed']), list(range(100, 107)))
        self.assertTrue(value['proof']['selectorClosed'])
        self.assertTrue(value['proof']['released'])
        self.assertEqual(value['proof']['remainingFds'], [])
        self.assertIsNone(value['terminal']['direct'])
        self.assertTrue(value['terminal']['directNotObserved'])
        self.assertTrue(value['terminal']['rangeEmpty'])
        self.assertTrue(value['terminal']['ioClosed'])
        self.assertFalse(value['terminal']['providerFailure'])
        self.assertFalse(value['terminal']['physicalStopRequired'])
        self.assertFalse(value['foreground']['rangeEmpty'])
        self.assertFalse(value['proof']['foregroundReleased'])

    def test_signal_success_does_not_substitute_for_exit_reap_all_eof_and_close(self):
        for missing in ['namespace', 'wrapper', 'stdout', 'stderr', 'diagnostic', 'status', 'metadata']:
            with self.subTest(missing=missing), World() as w:
                op, row = w.admitted('service', 1); w.commit(op, row)
                w.manager.stop_row(row, 'owner-stop', True)
                w.terminate(op, namespace=missing != 'namespace', wrapper=missing != 'wrapper', omitted=(missing,))
                w.manager.tick()
                self.assertFalse(op.empty())
                self.assertFalse(op.released)
                self.assertTrue(op.result()['providerFailure'])
                self.assertFalse(w.manager.snapshot(row)['rangeEmpty'])
                w.now += 2.01; w.manager.tick()
                self.assertTrue(w.manager.snapshot(row)['physicalStopRequired'])

    def test_esrch_unowned_pidfd_or_uncontrolled_cause_cannot_create_exemption(self):
        for variant in ['esrch', 'already-exited', 'unowned', 'passive', 'provider-failure', 'owner-finally', 'owner-seal', 'other']:
            with self.subTest(variant=variant), World() as w:
                op, row = w.admitted('service', 1); w.commit(op, row)
                if variant == 'esrch': w.signal_failure = ProcessLookupError()
                if variant == 'already-exited': w.gone.add(op.pidfd)
                if variant == 'unowned': op.fds.remove(op.pidfd)
                op.stop('owner-stop' if variant in ['esrch', 'already-exited', 'unowned', 'passive'] else variant,
                        kill=variant != 'passive')
                w.terminate(op); w.manager.tick()
                self.assertFalse(op.controlled_stop)
                self.assertTrue(w.manager.snapshot(row)['providerFailure'])

    def test_each_original_controlled_stop_cause_requires_actual_full_cleanup(self):
        for cause in ['owner-stop', 'cancel', 'run-deadline', 'output-budget']:
            with self.subTest(cause=cause), World() as w:
                op, row = w.admitted('service', 1); w.commit(op, row)
                op.stop(cause); self.assertTrue(op.result()['providerFailure'])
                w.terminate(op); op.pump(0)
                self.assertTrue(op.empty()); self.assertTrue(op.result()['providerFailure'])
                op.finish(); self.assertFalse(op.result()['providerFailure'])

    def test_failure_and_unknown_cleanup_keep_failure(self):
        for kind in ['uncontrolled', 'fault', 'fd-close', 'selector-close', 'namespace-gap', 'eof-gap']:
            with self.subTest(kind=kind):
                value = scenario(kind)
                self.assertTrue(value['proof']['result']['providerFailure'])
                if kind != 'uncontrolled':
                    self.assertTrue(value['terminal']['physicalStopRequired'] or value['terminal']['providerFailure'])
        for field in ['fault', 'failure', 'cleanup_failure']:
            with self.subTest(field=field), World() as w:
                op, row = w.admitted('service', 1); w.commit(op, row); op.stop('owner-stop')
                w.terminate(op); op.pump(0); op.finish()
                setattr(op, field, 'synthetic-real-failure')
                self.assertTrue(op.result()['providerFailure'])

    def test_signal_exception_keeps_attempt_latched_and_does_not_retry(self):
        with World() as w:
            op, row = w.admitted('service', 1); w.commit(op, row)
            w.signal_failure = OSError('synthetic send failure')
            w.manager.stop_row(row, 'owner-stop', True)
            self.assertTrue(op.signalled); self.assertFalse(op.controlled_stop)
            op.stop('owner-stop'); self.assertEqual(len(w.signals), 1)
            w.terminate(op); w.manager.tick()
            self.assertTrue(w.manager.snapshot(row)['providerFailure'])
            self.assertTrue(w.manager.snapshot(row)['physicalStopRequired'])


if __name__ == '__main__':
    if sys.argv[1:] == ['--vectors']:
        print(json.dumps({kind: scenario(kind) for kind in ['controlled', 'uncontrolled', 'fault', 'fd-close',
                                                           'selector-close', 'namespace-gap', 'eof-gap']}, separators=(',', ':')))
    else:
        unittest.main()
