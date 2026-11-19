"""Private, generation-bound application acknowledgements for the original SDK owner."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import hmac
import os
from pathlib import Path
import stat
from threading import RLock

from .deletion_completion import CompletionRecords, ID, SHA, decode, digest, encode, protected, read_file, require

MAX_ACKNOWLEDGED = 256
MAX_INDEX_BYTES = 32768
SCOPE_FIELDS = ('allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId')


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_atomic(path, raw):
    temporary = path.with_name('.next')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    _fsync_dir(path.parent)


def _archive_directory(root):
    return root.with_name('deletion-acknowledgements')


def _index(generation, policy, receipts):
    return {'v': 1, 'generation': generation, 'policy': policy, 'receipts': receipts}


def initialize_ack_domain(active_root: Path, generation: str, policy: str, *, uid=0):
    """Initialize one separately authorized unused work domain, never repair a missing ledger."""
    require(bool(SHA.fullmatch(generation)) and bool(SHA.fullmatch(policy)), 'ack-generation')
    require(active_root.name == 'deletion-completions', 'ack-active-domain')
    protected(active_root.parent, uid)
    archive = _archive_directory(active_root)
    require(not active_root.exists() and not active_root.is_symlink()
            and not archive.exists() and not archive.is_symlink(), 'ack-domain-already-exists')
    active_root.mkdir(mode=0o700)
    archive.mkdir(mode=0o700)
    _write_atomic(archive / 'index.json', encode(_index(generation, policy, {})))
    _fsync_dir(active_root.parent)


def _label_hash(raw):
    return 'h' + base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode('ascii').rstrip('=') + 'h'


class _OriginalUse:
    def __init__(self):
        self.lock = RLock()
        self.references = 0
        self.uncertain = False


class AcknowledgedCompletionRecords(CompletionRecords):
    """Retain exact SDK terminal evidence until authenticated application ACK and final reference."""

    def __init__(self, root, *, view, max_acknowledged=MAX_ACKNOWLEDGED, **kwargs):
        require(type(max_acknowledged) is int and 1 <= max_acknowledged <= MAX_ACKNOWLEDGED, 'ack-capacity')
        self.max_acknowledged = max_acknowledged
        self.archive = _archive_directory(root)
        self.view = view
        self.generation = view.assert_generation()
        self.policy = view.sha
        self.key_sha = view.policy['apiKeySha256']
        self.historical = frozenset(row['sandboxId'] for row in view.policy['historical'])
        self.ack_index = None
        self.ack_closed = False
        require(root.is_dir() and not root.is_symlink(), 'ack-active-domain')
        super().__init__(root, **kwargs)
        try:
            protected(self.archive, self.uid)
            st = self.archive.lstat()
            require(st.st_uid == self.uid and stat.S_IMODE(st.st_mode) == 0o700, 'ack-directory')
            require(st.st_dev == self.root.stat().st_dev, 'ack-work-device')
            self.ack_index = self._read_index()
            self._check_archive()
        except BaseException:
            super().close()
            raise

    def close(self):
        with self.serial():
            require(not self.original_locks, 'ack-active-references')
            if not self.ack_closed:
                self.ack_closed = True
                super().close()

    def _read_index(self):
        raw = read_file(self.archive / 'index.json', MAX_INDEX_BYTES, self.uid)
        stored = decode(raw)
        require(isinstance(stored, dict) and set(stored) == {'v', 'generation', 'policy', 'receipts'}
                and encode(stored) == raw and stored['v'] == 1
                and stored['generation'] == self.generation and stored['policy'] == self.policy, 'ack-index')
        entries = stored['receipts']
        require(isinstance(entries, dict) and len(entries) <= self.max_acknowledged
                and all(ID.fullmatch(sid) and isinstance(sha, str) and SHA.fullmatch(sha)
                        for sid, sha in entries.items()), 'ack-index-entries')
        require(not (self.historical & entries.keys()), 'ack-historical')
        return entries

    def _archived(self, sid):
        if self.ack_index is None or sid not in self.ack_index:
            return None
        raw = read_file(self.archive / (sid + '.json'), self.max_bytes, self.uid)
        require(hashlib.sha256(raw).hexdigest() == self.ack_index[sid], 'ack-archive-digest')
        record = decode(raw)
        require(record['sid'] == sid and record['phase'] == 'completed'
                and record['generation'] == self.generation and record['policy'] == self.policy, 'ack-archive-binding')
        return record

    def _check_archive(self):
        names = list(self.archive.iterdir())
        require(len(names) <= self.max_acknowledged + 1, 'ack-capacity')
        for sid in self.ack_index:
            self.get(sid)
        for path in names:
            if path.name == 'index.json':
                continue
            sid = path.stem
            require(path.suffix == '.json' and bool(ID.fullmatch(sid)), 'ack-partial-file')
            if sid not in self.ack_index:
                # A crash before publishing the index leaves this draft and the original together.
                original = super().get(sid)
                require(original['phase'] == 'completed' and sid not in self.historical
                        and read_file(path, self.max_bytes, self.uid) == encode(original), 'ack-uncommitted-draft')

    def get(self, sid):
        with self.serial():
            require(not self.ack_closed, 'ack-closed')
            active_path = self._path(sid)
            archived = self._archived(sid)
            if archived is None:
                return super().get(sid)
            if active_path.exists() or active_path.is_symlink():
                require(super().get(sid) == archived, 'ack-active-conflict')
            return archived

    def reserve(self, selected):
        with self.serial():
            require(not self.ack_closed, 'ack-closed')
            require(selected['sid'] not in self.ack_index, 'ack-original-already-retired')
            return super().reserve(selected)

    def confirm_durable(self, sid):
        with self.serial():
            require(not self.ack_closed, 'ack-closed')
            archived = self._archived(sid)
            if archived is None or self._path(sid).exists() or self._path(sid).is_symlink():
                return super().confirm_durable(sid)
            require(self._read_index() == self.ack_index, 'ack-index-changed')
            fd = os.open(self.archive / (sid + '.json'), os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            _fsync_dir(self.archive)

    @contextmanager
    def original_serial(self, sid):
        with self.serial():
            self.get(sid)
            entry = self.original_locks.get(sid)
            if entry is None:
                require(len(self.original_locks) < self.max_records, 'capacity')
                entry = _OriginalUse()
                self.original_locks[sid] = entry
            entry.references += 1
        acquired = False
        settled = False
        try:
            acquired = entry.lock.acquire(blocking=False)
            require(acquired, 'original-operation-pending')
            yield
            settled = True
        finally:
            if acquired:
                entry.lock.release()
            with self.serial():
                entry.references -= 1
                if acquired and not settled:
                    entry.uncertain = True
                if entry.references == 0:
                    del self.original_locks[sid]
                    if settled and not entry.uncertain and sid in self.ack_index:
                        self._retire(sid)

    def _authenticate(self, key):
        require(isinstance(key, bytes) and 0 < len(key) <= 4096
                and hmac.compare_digest(hashlib.sha256(key).hexdigest(), self.key_sha), 'ack-auth')

    def _receipt(self, record, scope):
        require(isinstance(scope, (list, tuple)) and len(scope) == 10, 'ack-scope')
        scope = tuple(scope)
        require(all(isinstance(value, str) and value.isascii() and value.isprintable()
                    and 0 < len(value) <= 4096 for value in scope), 'ack-scope')
        require(record['sid'] not in self.historical and record['phase'] == 'completed', 'ack-terminal')
        self.view.assert_original(record)
        require(record['labels']['pe-allocation'] == _label_hash(scope[0].encode('ascii'))
                and record['labels']['pe-scope'] == _label_hash(encode(list(scope))), 'ack-scope-binding')
        return {**dict(zip(SCOPE_FIELDS, scope[:5])), 'sandboxId': record['sid'], 'containerId': record['cid'],
                'providerGeneration': record['generation'], 'policyDigest': record['policy'], 'receiptDigest': digest(record)}

    def completed_receipt(self, key, sid, scope):
        """Read the exact positive terminal receipt over the original authentication authority."""
        self._authenticate(key)
        with self.original_serial(sid):
            record = self.get(sid)
            result = self._receipt(record, scope)
            require(self.view.assert_absent_and_cleanup(record) == record['cleanup'], 'ack-cleanup')
            self.confirm_durable(sid)
            self.view.assert_original(record)
            return result

    def acknowledge(self, key, scope, receipt):
        """Confirm an exact application-persisted receipt with durable same-digest replay."""
        self._authenticate(key)
        require(isinstance(receipt, dict) and len(receipt) == len(SCOPE_FIELDS) + 5
                and isinstance(receipt.get('sandboxId'), str), 'ack-receipt')
        receipt = dict(receipt)
        sid = receipt['sandboxId']
        with self.original_serial(sid):
            record = self.get(sid)
            expected = self._receipt(record, scope)
            require(receipt == expected, 'ack-receipt-binding')
            require(self.view.assert_absent_and_cleanup(record) == record['cleanup'], 'ack-cleanup')
            self.confirm_durable(sid)
            with self.serial():
                self._archive_ack(sid, record)
            self.view.assert_original(record)
            return expected

    def _archive_ack(self, sid, record):
        require(self._read_index() == self.ack_index, 'ack-index-changed')
        if sid in self.ack_index:
            require(self._archived(sid) == record, 'ack-archive-binding')
            return
        require(len(self.ack_index) < self.max_acknowledged, 'ack-capacity')
        path = self.archive / (sid + '.json')
        raw = encode(record)
        if not path.exists() and not path.is_symlink():
            require(len(list(self.archive.iterdir())) <= self.max_acknowledged, 'ack-capacity')
            _write_atomic(path, raw)
        require(read_file(path, self.max_bytes, self.uid) == raw, 'ack-archive-readback')
        _fsync_dir(self.archive)
        updated = {**self.ack_index, sid: digest(record)}
        encoded = encode(_index(self.generation, self.policy, updated))
        require(len(encoded) <= MAX_INDEX_BYTES, 'ack-index-size')
        _write_atomic(self.archive / 'index.json', encoded)
        require(self._read_index() == updated, 'ack-index-readback')
        self.ack_index = updated

    def _retire(self, sid):
        active = self._path(sid)
        if not active.exists() and not active.is_symlink():
            return
        require(sid not in self.original_locks and sid not in self.historical, 'ack-active-references')
        require(self._read_index() == self.ack_index, 'ack-index-changed')
        record = self._archived(sid)
        require(record is not None and record == super().get(sid), 'ack-active-conflict')
        self.view.assert_original(record)
        active.unlink()
        _fsync_dir(self.root)
