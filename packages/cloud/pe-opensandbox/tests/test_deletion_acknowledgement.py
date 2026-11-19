"""Exercise the original deletion owner and local durable ACK records without an SDK or Docker."""
import base64
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
from types import ModuleType, SimpleNamespace
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
server = ModuleType('original_sdk_server_sources')
server.__path__ = [str(PACKAGE / 'runtime' / 'server')]
sys.modules[server.__name__] = server
sdk = importlib.import_module(server.__name__ + '.deletion_completion')
ack = importlib.import_module(server.__name__ + '.deletion_acknowledgement')

KEY = b'only-synthetic-original-control-key'
GENERATION = 'a' * 64
POLICY = 'b' * 64
CLEANUP = 'c' * 64


def sid(index):
    return f'0a000000-0000-4000-8000-{index:012x}'


def scope(index):
    return [f'allocation-{index}', 'account-1', '1', f'session-{index}', 'workspace-1', 'image-1',
            'opensandbox', 'mount-1', '2026-11-18T00:00:00.000Z', '2026-11-18T00:01:00.000Z']


def label(value):
    wire = base64.b64encode(hashlib.sha256(value.encode()).digest(), altchars=b'-_')
    return 'h' + wire.decode('ascii').removesuffix('=') + 'h'


def original(index):
    vector = scope(index)
    labels = {'opensandbox.io/id': sid(index), 'pe-allocation': label(vector[0]),
              'pe-scope': label(json.dumps(vector, separators=(',', ':'))), 'pe-recipe': 'recipe-1'}
    return sdk.binding(sid(index), GENERATION, POLICY, labels, '8')


class OriginalView:
    def __init__(self, historical=()):
        self.generation = GENERATION
        self.sha = POLICY
        self.cleanup = CLEANUP
        self.policy = {'apiKeySha256': hashlib.sha256(KEY).hexdigest(),
                       'historical': [{'sandboxId': item} for item in historical]}

    def assert_generation(self):
        return self.generation

    def assert_original(self, record):
        sdk.require(record['generation'] == self.generation and record['policy'] == self.sha, 'original-owner-changed')

    def assert_absent_and_cleanup(self, record):
        self.assert_original(record)
        return self.cleanup

    def requires_full_history(self, record):
        return any(item['sandboxId'] == record['sid'] for item in self.policy['historical'])

    def retained_history(self, record):
        actions = ('create', 'start', 'die', 'destroy') if self.requires_full_history(record) else ('destroy',)
        return b''.join(sdk.encode({'Type': 'container', 'Action': action, 'timeNano': offset,
                                   'Actor': {'ID': record['cid'], 'Attributes': {**record['labels'],
                                                                                'opensandbox.io/platform-os': 'linux'}}}) + b'\n'
                        for offset, action in enumerate(actions, 1))


def open_owner(root, *, view=None, **limits):
    return ack.AcknowledgedCompletionRecords(root, uid=os.getuid(), require_domain=False,
                                             view=view or OriginalView(), **limits)


class Acknowledgements(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix='sdk-ack-test-', dir=PACKAGE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'deletion-completions'
        ack.initialize_ack_domain(self.root, GENERATION, POLICY, uid=os.getuid())
        self.view = OriginalView()
        self.owner = open_owner(self.root, view=self.view)
        self.addCleanup(lambda: self.owner.close())
        self.removed = []

    def reserve(self, index):
        return self.owner.reserve(original(index))

    def complete(self, index):
        self.reserve(index)
        self.owner.bind(sid(index), f'{index:064x}')
        self.finish(sid(index))

    def finish(self, sandbox_id):
        def remove(selected, *, expected_container_id):
            self.removed.append((selected, expected_container_id))
        sdk.finish_original_delete(SimpleNamespace(
            _deletion_records=self.owner, _deletion_view=self.view, _delete_sandbox_without_completion=remove,
        ), sandbox_id)

    def receipt(self, index):
        return self.owner.completed_receipt(KEY, sid(index), scope(index))

    def acknowledge(self, index):
        return self.owner.acknowledge(KEY, scope(index), self.receipt(index))

    def reopen(self, **limits):
        self.owner.close()
        self.owner = open_owner(self.root, view=self.view, **limits)

    def test_rejects_untrusted_auth_scope_generation_container_digest_and_unknown(self):
        self.complete(1)
        original_bytes = self.owner._path(sid(1)).read_bytes()
        # The fixed label is also produced by the original TypeScript JSON.stringify and SHA-256 base64url.
        self.assertEqual(self.owner.get(sid(1))['labels']['pe-scope'], 'hOFO7h86RlpvRUWsDkPXy9ftA-H1Bl5WZu7YsMuL0A2gh')
        evidence = self.receipt(1)
        with self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-auth'):
            self.owner.acknowledge(b'wrong-key', scope(1), evidence)
        with self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-scope-binding'):
            self.owner.acknowledge(KEY, scope(2), evidence)
        for key in ('containerId', 'providerGeneration', 'policyDigest', 'receiptDigest'):
            with self.subTest(key=key), self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-receipt-binding'):
                self.owner.acknowledge(KEY, scope(1), {**evidence, key: 'f' * 64})
        self.reserve(2)
        with self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-terminal'):
            self.owner.acknowledge(KEY, scope(2), {**evidence, 'sandboxId': sid(2)})
        self.view.generation = 'd' * 64
        with self.assertRaisesRegex(sdk.CompletionUnknown, 'original-owner-changed'):
            self.owner.acknowledge(KEY, scope(1), evidence)
        self.view.generation = GENERATION
        self.view.cleanup = 'e' * 64
        with self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-cleanup'):
            self.owner.acknowledge(KEY, scope(1), evidence)
        self.assertEqual(self.owner.ack_index, {})
        self.assertEqual(self.owner._path(sid(1)).read_bytes(), original_bytes)

    def test_last_reentrant_reference_defers_retirement_and_cross_thread_cannot_get_a_new_lock(self):
        self.complete(1)
        evidence = self.receipt(1)
        active = self.owner._path(sid(1))
        contended = []
        def second():
            try:
                self.owner.completed_receipt(KEY, sid(1), scope(1))
            except sdk.CompletionUnknown as error:
                contended.append(error.code)
        with self.owner.original_serial(sid(1)):
            self.assertEqual(self.owner.acknowledge(KEY, scope(1), evidence), evidence)
            self.assertIn(sid(1), self.owner.ack_index)
            self.assertTrue(active.exists())
            worker = Thread(target=second)
            worker.start()
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(contended, ['original-operation-pending'])
            with self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-active-references'):
                self.owner.close()
            self.assertTrue(active.exists())
        self.assertFalse(active.exists())
        self.assertEqual(self.owner.original_locks, {})
        self.finish(sid(1))  # The original DELETE again serves the completed receipt.
        self.assertEqual(self.removed, [(sid(1), f'{1:064x}')])

    def test_lost_ack_and_process_exit_replay_only_exact_evidence(self):
        self.complete(1)
        before = self.receipt(1)
        self.owner.close()
        child = subprocess.run([sys.executable, '-I', '-S', '-B', __file__, '--exit-after-ack', str(self.root)],
                               capture_output=True, timeout=10, check=False)
        self.assertEqual(child.returncode, 61, child.stderr.decode())
        self.reopen()
        self.assertTrue(self.owner._path(sid(1)).exists())
        self.assertEqual(self.owner.ack_index[sid(1)], before['receiptDigest'])
        self.assertEqual(self.owner.acknowledge(KEY, scope(1), before), before)
        self.assertFalse(self.owner._path(sid(1)).exists())
        self.reopen()
        for _ in range(2):
            self.assertEqual(self.owner.acknowledge(KEY, scope(1), before), before)
        with self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-original-already-retired'):
            self.reserve(1)
        self.finish(sid(1))
        self.assertEqual(self.removed, [(sid(1), f'{1:064x}')])

    def test_failure_within_held_original_reference_retains_until_clean_retry(self):
        self.complete(1)
        evidence = self.receipt(1)
        with self.assertRaisesRegex(RuntimeError, 'unknown held operation'):
            with self.owner.original_serial(sid(1)):
                self.assertEqual(self.owner.acknowledge(KEY, scope(1), evidence), evidence)
                raise RuntimeError('unknown held operation')
        self.assertTrue(self.owner._path(sid(1)).exists())
        self.assertEqual(self.owner.acknowledge(KEY, scope(1), evidence), evidence)
        self.assertFalse(self.owner._path(sid(1)).exists())

    def test_historical_and_bounded_archive_keep_unacknowledged_records(self):
        self.view.policy['historical'] = [{'sandboxId': sid(1)}]
        self.reopen(max_acknowledged=1)
        self.complete(1)
        with self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-terminal'):
            self.receipt(1)
        self.complete(2)
        self.acknowledge(2)
        self.complete(3)
        with self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-capacity'):
            self.acknowledge(3)
        self.assertTrue(self.owner._path(sid(1)).exists())
        self.assertTrue(self.owner._path(sid(3)).exists())
        self.assertEqual(set(self.owner.ack_index), {sid(2)})

    def test_129th_original_requires_reclaiming_positive_ack(self):
        self.complete(1)
        for index in range(2, 129):
            self.reserve(index)
        with self.assertRaisesRegex(sdk.CompletionUnknown, '/capacity'):
            self.reserve(129)
        self.acknowledge(1)
        self.assertEqual(self.reserve(129)['phase'], 'reserved')
        self.assertEqual(self.owner.get(sid(1))['phase'], 'completed')
        self.assertEqual(self.owner.original_locks, {})
        self.assertEqual(len(list(self.root.glob('*.json'))), 128)

    def test_missing_archived_receipt_and_logical_index_loss_are_refused(self):
        self.complete(1)
        self.acknowledge(1)
        self.owner.close()
        archive = self.owner.archive / (sid(1) + '.json')
        raw = archive.read_bytes()
        archive.unlink()
        with self.assertRaises(FileNotFoundError):
            self.reopen()
        archive.write_bytes(raw)
        archive.chmod(0o600)
        self.reopen()
        self.owner.close()
        index = self.owner.archive / 'index.json'
        value = sdk.decode(index.read_bytes())
        value['receipts'] = {}
        index.write_bytes(sdk.encode(value))  # A logically valid index with an orphaned committed receipt.
        with self.assertRaises(FileNotFoundError):
            self.reopen()
        with self.assertRaisesRegex(sdk.CompletionUnknown, 'ack-domain-already-exists'):
            ack.initialize_ack_domain(self.root, GENERATION, POLICY, uid=os.getuid())

    def test_uncommitted_archive_copy_keeps_active_record_and_allows_exact_retry(self):
        self.complete(1)
        evidence = self.receipt(1)
        active = self.owner._path(sid(1))
        original_bytes = active.read_bytes()
        draft = self.owner.archive / (sid(1) + '.json')
        ack._write_atomic(draft, original_bytes)
        self.reopen()
        self.assertEqual(self.owner.ack_index, {})
        self.assertEqual(active.read_bytes(), original_bytes)
        self.assertEqual(self.owner.acknowledge(KEY, scope(1), evidence), evidence)
        self.assertFalse(active.exists())
        self.assertEqual(draft.read_bytes(), original_bytes)


if __name__ == '__main__':
    if sys.argv[1:2] == ['--exit-after-ack']:
        owner = open_owner(Path(sys.argv[2]))
        evidence = owner.completed_receipt(KEY, sid(1), scope(1))
        with owner.original_serial(sid(1)):
            owner.acknowledge(KEY, scope(1), evidence)
            os._exit(61)  # Archived ACK is durable, the outer reference has not settled, and no reply was used.
    unittest.main(verbosity=2)
