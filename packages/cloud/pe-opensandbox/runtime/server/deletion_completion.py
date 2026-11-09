"""Bounded deletion records used only by the existing DockerSandboxService owner.

This module owns no container, process, mount, dispatcher or background worker.
It never turns an absent resource,404 or elapsed TTL into completion evidence.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from threading import Lock, RLock
from typing import Any

MAX_RECORDS = 128
MAX_RECORD_BYTES = 2048
MAX_HISTORY_BYTES = 65536
MAX_HISTORY_EVENTS = 64
ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
LABEL_KEYS = ('opensandbox.io/id', 'pe-allocation', 'pe-scope', 'pe-recipe')


class CompletionUnknown(RuntimeError):
    def __init__(self, code: str):
        super().__init__('deletion-completion/' + code)
        self.code = code


class OriginalMissing(RuntimeError):
    """Only the existing owner's exact pre-delete404 lookup may raise this."""


def require(ok: bool, code: str) -> None:
    if not ok:
        raise CompletionUnknown(code)


def encode(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(encode(value)).hexdigest()


def pairs_unique(rows):
    result = {}
    for key, value in rows:
        require(key not in result, 'duplicate-key')
        result[key] = value
    return result


def decode(raw: bytes):
    return json.loads(raw, object_pairs_hook=pairs_unique)


def protected(path: Path, uid: int, final_directory: bool = True) -> None:
    require(path.is_absolute() and str(path) == os.path.normpath(path), 'path')
    for part in [*reversed(path.parents), *([path] if final_directory else [])]:
        st = part.lstat()
        require(stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode)
                and st.st_uid in (0, uid) and not st.st_mode & 0o022, 'parent')


def read_file(path: Path, maximum: int, uid: int, modes=(0o600,)) -> bytes:
    protected(path, uid, False)
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1
            and stat.S_IMODE(before.st_mode) in modes and 0 < before.st_size <= maximum, 'file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(maximum + 1)
        after = os.fstat(fd)
        stamp = lambda s: (s.st_dev, s.st_ino, s.st_uid, s.st_mode, s.st_nlink,
                           s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(stamp(before) == stamp(after) == stamp(path.lstat()) and len(raw) == before.st_size, 'file-changed')
        return raw
    finally:
        os.close(fd)


def binding(sid: str, generation: str, policy: str, labels: dict[str, str], since='0') -> dict:
    require(bool(ID.fullmatch(sid)) and bool(SHA.fullmatch(generation)) and bool(SHA.fullmatch(policy)), 'binding')
    require(set(labels) == set(LABEL_KEYS) and labels['opensandbox.io/id'] == sid
            and all(isinstance(x, str) and 0 < len(x) <= 128 for x in labels.values()), 'labels')
    require(isinstance(since, str) and bool(re.fullmatch(r'[0-9]{1,20}', since)), 'history-since')
    return {'sid': sid, 'generation': generation, 'policy': policy, 'labels': dict(labels),
            'profile': 'linux-fixed-host-bind-v1', 'since': since}


def verify_history(raw: bytes, record: dict, *, full_chain=True) -> str:
    """Positive actual history; no completeness/absence inference from an empty stream."""
    require(0 < len(raw) <= MAX_HISTORY_BYTES and bool(SHA.fullmatch(record.get('cid', ''))), 'history-bounds')
    rows = [decode(line) for line in raw.splitlines() if line.strip()]
    require(0 < len(rows) <= MAX_HISTORY_EVENTS, 'history-bounds')
    required = ['create', 'start', 'die', 'destroy'] if full_chain else ['destroy']
    positions = []
    last_time = -1
    for row in rows:
        actor = row.get('Actor', {})
        attrs = actor.get('Attributes', {})
        timestamp = row.get('timeNano')
        require(row.get('Type') == 'container' and actor.get('ID') == record['cid']
                and type(timestamp) is int and timestamp > 0 and timestamp >= last_time, 'history-identity')
        require(all(attrs.get(k) == v for k, v in record['labels'].items()), 'history-labels')
        require(attrs.get('opensandbox.io/platform-os') == 'linux'
                and not attrs.get('opensandbox.io/ossfs-mounts')
                and not attrs.get('opensandbox.io/volume-managed-by'), 'history-profile')
        last_time = timestamp
    for action in required:
        matches = [i for i, row in enumerate(rows) if row.get('Action') == action]
        require(len(matches) == 1, 'history-positive-event')
        positions.append(matches[0])
    require(positions == sorted(positions) and len(set(positions)) == len(required), 'history-order')
    require(hashlib.sha256(raw).hexdigest() == record.get('history'), 'history-digest')
    return record['history']


class CompletionRecords:
    """Per-original fixed records, not a lifecycle owner or a generic ledger.

    Unknown/unacknowledged records are never evicted. No API garbage collection
    is introduced: Root retires the existing protected domain only after its
    original terminal release and selected-server exit have actually settled.
    """
    def __init__(self, root: Path, *, uid=0, require_domain=True, max_records=MAX_RECORDS,
                 max_bytes=MAX_RECORD_BYTES, peak_hook=None):
        self.root, self.uid = root, uid
        self.max_records, self.max_bytes = max_records, max_bytes
        self.mutex = RLock()
        self.original_locks = {}
        self.peak_hook = peak_hook
        require(0 < max_records <= MAX_RECORDS and 512 <= max_bytes <= MAX_RECORD_BYTES, 'limits')
        protected(root.parent, uid)
        if require_domain:
            require(str(root) == '/work/deletion-completions' and uid == 0, 'work-domain')
            fs = os.statvfs(root.parent)
            require(fs.f_frsize * fs.f_blocks == 33554432 and fs.f_files == 1024, 'work-domain')
        if not root.exists():
            root.mkdir(mode=0o700)
        protected(root, uid)
        st = root.lstat()
        require(st.st_uid == uid and stat.S_IMODE(st.st_mode) == 0o700, 'record-directory')
        self.lock_fd = os.open(root / '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        st = os.fstat(self.lock_fd)
        require(st.st_uid == uid and st.st_nlink == 1 and stat.S_ISREG(st.st_mode)
                and stat.S_IMODE(st.st_mode) == 0o600, 'lock')
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._inventory()  # A partial tmp/corrupt record fails closed; never silently removed.
        except BaseException:
            os.close(self.lock_fd)
            raise

    def close(self):
        os.close(self.lock_fd)

    @contextmanager
    def serial(self):
        with self.mutex:
            yield

    @contextmanager
    def original_serial(self, sid):
        with self.serial():
            self.get(sid)  # Unknown IDs never allocate lock records.
            if sid not in self.original_locks:
                require(len(self.original_locks) < self.max_records, 'capacity')
                self.original_locks[sid] = RLock()
            lock = self.original_locks[sid]
        require(lock.acquire(blocking=False), 'original-operation-pending')
        try:
            yield
        finally:
            lock.release()

    def _path(self, sid):
        require(isinstance(sid, str) and bool(ID.fullmatch(sid)), 'sandbox-id')
        return self.root / (sid + '.json')

    def _inventory(self):
        names = list(self.root.iterdir())
        require(len(names) <= self.max_records + 1, 'capacity')
        for p in names:
            if p.name == '.lock':
                continue
            require(p.suffix == '.json' and bool(ID.fullmatch(p.stem)), 'partial-or-unexpected-record')
            self.get(p.stem)
        return len(names) - 1

    def get(self, sid):
        raw = read_file(self._path(sid), self.max_bytes, self.uid)
        value = decode(raw)
        require(encode(value) == raw and value.get('v') == 1 and value.get('sid') == sid
                and value.get('phase') in ('reserved', 'bound', 'fenced', 'completed'), 'record-format')
        require(set(value) == {'v', 'sid', 'generation', 'policy', 'labels', 'profile', 'since', 'cid',
                               'phase', 'history', 'completion', 'cleanup'}, 'record-fields')
        binding(sid, value['generation'], value['policy'], value['labels'], value['since'])
        require(value['profile'] == 'linux-fixed-host-bind-v1', 'record-profile')
        require(value['cid'] is None if value['phase'] == 'reserved'
                else isinstance(value['cid'], str) and bool(SHA.fullmatch(value['cid'])), 'record-cid')
        for key in ('history', 'completion', 'cleanup'):
            require(value[key] is None or isinstance(value[key], str) and bool(SHA.fullmatch(value[key])), 'record-digest')
        require((value['history'] is not None and value['completion'] is not None and value['cleanup'] is not None)
                if value['phase'] == 'completed' else value['completion'] is None and value['cleanup'] is None,
                'record-phase')
        return value

    def _write(self, value, new=False):
        raw = encode(value)
        require(len(raw) <= self.max_bytes, 'receipt-bytes')
        fs = os.statvfs(self.root)
        require(fs.f_bavail * fs.f_frsize >= fs.f_frsize * 3 and fs.f_favail >= 2, 'domain-capacity')
        target = self._path(value['sid'])
        if not new:
            self.get(value['sid'])
        temp = self.root / '.next'
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(raw); stream.flush(); os.fsync(fd)
            if self.peak_hook:
                self.peak_hook(self.root)
            if new:
                os.link(temp, target, follow_symlinks=False)  # Exclusive first reservation.
                temp.unlink()
            else:
                os.replace(temp, target)
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            os.close(fd)
        # Any write/fsync failure retains partial evidence and cannot return success.

    def reserve(self, selected):
        sid = selected['sid']
        with self.serial():
            if self._path(sid).exists() or self._path(sid).is_symlink():
                old = self.get(sid)
                require(all(old.get(k) == v for k, v in selected.items()), 'original-binding-changed')
                return old
            require(self._inventory() < self.max_records, 'capacity')
            value = {'v': 1, **selected, 'cid': None, 'phase': 'reserved', 'history': None,
                     'completion': None, 'cleanup': None}
            self._write(value, True)
            return value

    def bind(self, sid, cid, *, history=None):
        require(isinstance(cid, str) and bool(SHA.fullmatch(cid)), 'container-id')
        with self.serial():
            value = self.get(sid)
            if value['phase'] != 'reserved':
                require(value['cid'] == cid and value['history'] == history, 'container-binding-changed')
                return value
            value.update(cid=cid, history=history, phase='bound')
            self._write(value)
            return value

    def fence(self, sid):
        with self.serial():
            value = self.get(sid)
            require(value['phase'] in ('bound', 'fenced', 'completed'), 'unbound-original')
            if value['phase'] == 'bound':
                value['phase'] = 'fenced'; self._write(value)
            return value

    def commit(self, value, completion, cleanup):
        with self.serial():
            require(value['phase'] == 'fenced' and value['history'] is not None
                    and bool(SHA.fullmatch(completion))
                    and bool(SHA.fullmatch(cleanup)), 'incomplete')
            value.update(phase='completed', completion=completion, cleanup=cleanup)
            self._write(value)

    def retain_history_digest(self, sid, history_sha):
        with self.serial():
            value = self.get(sid)
            require(value['phase'] == 'fenced' and bool(SHA.fullmatch(history_sha)), 'history-state')
            require(value['history'] in (None, history_sha), 'history-changed')
            value['history'] = history_sha
            self._write(value)
            return value

    def confirm_durable(self, sid):
        with self.serial():
            value = self.get(sid)
            require(value['phase'] == 'completed', 'not-completed')
            fd = os.open(self._path(sid), os.O_RDONLY | os.O_NOFOLLOW)
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd); os.fsync(directory)
            finally:
                os.close(fd); os.close(directory)


def finish_original_delete(service, sid: str):
    """Called only inside the existing authenticated DELETE/expiry owner.

    The view is the concrete read-only native adapter, not caller booleans.
    This provider receipt says nothing about Root-local admission or I/O; the
    unchanged SDK must fence/join those before/after its ordinary DELETE.
    """
    records, view = service._deletion_records, service._deletion_view
    with records.original_serial(sid):
        selected = records.fence(sid)
        view.assert_original(selected)
        if selected['phase'] == 'completed':
            view.assert_absent_and_cleanup(selected)
            records.confirm_durable(sid)
            return
        removed_here = False
        try:
            service._delete_sandbox_without_completion(sid, expected_container_id=selected['cid'])
            removed_here = True  # Actual existing owner kill/remove/cleanup returned, not a JSON assertion.
        except OriginalMissing:
            pass
        # Every completion, including fresh owner TTL/remove, needs the actual
        # same-CID positive destroy chain. An owner callback return alone is not it.
        raw_history = view.retained_history(selected)
        history_sha = hashlib.sha256(raw_history).hexdigest()
        require(selected['history'] in (None, history_sha), 'history-changed')
        verify_history(raw_history, {**selected, 'history': history_sha},
                       full_chain=view.requires_full_history(selected))
        selected = records.retain_history_digest(sid, history_sha)
        if not removed_here:
            # Existing owner metadata cleanup is allowed only AFTER positive
            # original destruction evidence. Its best-effort return is not proof.
            service._metadata_store.delete(sid)
        view.assert_original(selected)
        # Original best-effort returns are insufficient: concrete view re-queries
        # exact auxiliary identities and metadata paths; any uncertainty rejects.
        cleanup = view.assert_absent_and_cleanup(selected)
        proof = digest({'binding': digest({k: selected[k] for k in ('sid', 'cid', 'generation', 'policy', 'labels', 'profile')}),
                        'source': 'original-owner-remove' if removed_here else selected['history']})
        records.commit(selected, proof, cleanup)
