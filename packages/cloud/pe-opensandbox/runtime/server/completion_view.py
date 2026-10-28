"""Concrete readonly checks borrowed by the existing Docker deletion owner.

Root must supply pinned policy/request/history files and readonly views of the
ORIGINAL backend procfs/cgroup2. This file creates no resource or new owner.
"""
from __future__ import annotations

import hashlib
import base64
import json
import os
from pathlib import Path
import re
import stat
import time
from types import SimpleNamespace

from docker.errors import NotFound
from opensandbox_server.api.schema import CreateSandboxRequest
from .deletion_completion import (CompletionRecords, CompletionUnknown, binding, decode,
                                  digest, read_file, require, verify_history)

PROC = Path('/owner-observation/proc')
CGROUP = Path('/owner-observation/cgroup')
FIXED_IMAGE = 'sha256:3a1883e6bd3272095de9407f33bcb0119dcc664e6cff2952cd0931caa8e0bf9f'
FIXED_CREATOR_SHA = '831b9f941abb7ef01603d8ed1ec25fb92480628033cf239279b97f12871d5a38'


def _read_proc(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(maximum + 1)
        require(len(raw) <= maximum, 'native-read-bounds')
        return raw.decode('utf-8', errors='strict')
    finally:
        os.close(fd)


def _readonly_view(path, filesystem):
    rows = _read_proc(Path('/proc/self/mountinfo'), 1048576).splitlines()
    require(len(rows) <= 8192, 'mount-bounds')
    selected = None
    for row in rows:
        left, right = row.split(' - ')
        fields = left.split(); kind = right.split()[0]
        mount = fields[4]
        if str(path) == mount:
            selected = (fields[5].split(','), kind)
    require(selected is not None and 'ro' in selected[0] and 'rw' not in selected[0]
            and selected[1] == filesystem and path.is_dir() and not path.is_symlink(), 'native-view')


class OriginalDockerView:
    def __init__(self, service, policy_file, policy_sha):
        self.service, self.path, self.sha = service, Path(policy_file), policy_sha
        require(str(self.path) == '/work/deletion-completion-policy.json', 'policy-path')
        raw = read_file(self.path, 16384, 0, (0o400, 0o440, 0o444))
        require(hashlib.sha256(raw).hexdigest() == policy_sha, 'policy-digest')
        self.policy = decode(raw)
        require(set(self.policy) == {'version', 'generation', 'socket', 'image', 'entrypoint', 'platform',
                                    'apiKeySha256', 'admitCreates', 'historical', 'storageMode'}, 'policy-fields')
        require(self.policy['version'] == 2 and self.policy['storageMode'] == 'shared-path'
                and type(self.policy['admitCreates']) is bool
                and len(self.policy['historical']) <= 1, 'policy-bounds')
        require(self.policy['image'] == FIXED_IMAGE and self.policy['platform'] == 'arm64'
                and self.policy['entrypoint'] == ['/usr/bin/tail', '-f', '/dev/null'], 'fixed-recipe-policy')
        key = service.app_config.server.api_key
        require(isinstance(key, str) and bool(key.strip())
                and hashlib.sha256(key.encode()).hexdigest() == self.policy['apiKeySha256'], 'original-auth-owner')
        require(1 <= service._api_timeout <= 2, 'finite-native-io')
        _readonly_view(PROC, 'proc'); _readonly_view(CGROUP, 'cgroup2')
        self.assert_generation()

    def assert_generation(self):
        raw = read_file(self.path, 16384, 0, (0o400, 0o440, 0o444))
        require(hashlib.sha256(raw).hexdigest() == self.sha, 'policy-changed')
        selected = self.policy['generation']
        require(set(selected) == {'backendId', 'pid', 'startTicks', 'mountNamespace'}
                and type(selected['pid']) is int and selected['pid'] > 1
                and isinstance(selected['backendId'], str) and bool(re.fullmatch(r'[0-9a-f]{64}', selected['backendId']))
                and isinstance(selected['startTicks'], str) and bool(re.fullmatch(r'[0-9]{1,20}', selected['startTicks']))
                and isinstance(selected['mountNamespace'], str)
                and bool(re.fullmatch(r'mnt:\[[0-9]{1,20}\]', selected['mountNamespace'])), 'generation-binding')
        text = _read_proc(PROC / str(selected['pid']) / 'stat', 8192)
        end = text.rfind(')')
        require(end > 0 and text[text.index('(') + 1:end] == 'dockerd'
                and text[end + 2:].split()[19] == selected['startTicks']
                and os.readlink(PROC / str(selected['pid']) / 'ns/mnt') == selected['mountNamespace'], 'generation-changed')
        socket = self.policy['socket']
        require(set(socket) == {'path', 'device', 'inode'} and socket['path'] == '/run/backend/docker.sock'
                and type(socket['device']) is int and socket['device'] >= 0
                and type(socket['inode']) is int and socket['inode'] > 0, 'socket-binding')
        metadata = Path(socket['path']).lstat()
        api = self.service.docker_client.api
        require(stat.S_ISSOCK(metadata.st_mode) and metadata.st_uid == 0
                and metadata.st_dev == socket['device'] and metadata.st_ino == socket['inode']
                and api.base_url == 'http+docker://localhost'
                and api.get_adapter(api.base_url).socket_path == socket['path'], 'socket-view-binding')
        return digest({'generation': selected, 'socket': socket})

    def _fixed_host_bind_agreement(self, volumes, allowed):
        """The original three roles, optionally with their fixed writable skills child."""
        with_skills = len(volumes) == 4
        names = ['project', 'protected-project-pe']
        if with_skills:
            names.append('project-skill-copies')
        names.append('session-environment')
        require([v.name for v in volumes] == names, 'host-bind-roles')
        modes = (False, True, False, False) if with_skills else (False, True, False)
        for volume, readonly in zip(volumes, modes):
            require(volume.host is not None and volume.pvc is None and volume.ossfs is None
                    and volume.sub_path is None and volume.read_only is readonly, 'host-bind-mode')
            for path in (volume.host.path, volume.mount_path):
                require(isinstance(path, str) and 0 < len(path.encode()) <= 4096
                        and path.startswith('/') and not path.endswith('/')
                        and not any(c in path for c in ('\\', ':', '\0', '\r', '\n'))
                        and os.path.normpath(path) == path, 'host-bind-path')
        project, protected_project, environment = volumes[0], volumes[1], volumes[-1]
        source = project.host.path
        project_domain, leaf = os.path.split(source)
        require(project_domain in allowed and os.path.basename(project_domain) == 'projects'
                and (leaf == 'default-workspace' or re.fullmatch(
                    r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', leaf)),
                'host-bind-project')
        require(os.path.basename(project.mount_path) == leaf
                and os.path.basename(os.path.dirname(project.mount_path)) == 'projects'
                and protected_project.host.path == source + '/.pe'
                and protected_project.mount_path == project.mount_path + '/.pe', 'host-bind-child')
        if with_skills:
            skills = volumes[2]
            require(skills.host.path == protected_project.host.path + '/skills'
                    and skills.mount_path == protected_project.mount_path + '/skills', 'host-bind-child')
        environment_source = environment.host.path
        environment_pool, environment_leaf = os.path.split(environment_source)
        account_environments = os.path.join(os.path.dirname(project_domain), 'environments')
        legacy_environment = (environment_source in allowed
                              and environment_pool == account_environments
                              and re.fullmatch(r'slot-[01]', environment_leaf))
        session_environment = (environment_pool in allowed
                               and os.path.dirname(environment_pool) == account_environments
                               and re.fullmatch(r'slot-[01]', os.path.basename(environment_pool))
                               and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', environment_leaf))
        require((legacy_environment or session_environment)
                and environment.mount_path == '/opt/session-env', 'host-bind-environment')
        require(len({v.host.path for v in volumes}) == len(volumes)
                and len({v.mount_path for v in volumes}) == len(volumes)
                and not (project.mount_path == '/opt/session-env'
                         or project.mount_path.startswith('/opt/session-env/')), 'host-bind-alias')

    def request_binding(self, sid, request, *, historical=False):
        require(historical or self.policy['admitCreates'], 'create-admission-closed')
        require(request.image is not None and request.image.uri == self.policy['image']
                and request.image.auth is None and request.snapshot_id is None
                and request.template_id is None and request.resource_requests is None
                and not request.env
                and list(request.entrypoint or []) == self.policy['entrypoint']
                and request.platform is not None and request.platform.os == 'linux'
                and request.platform.arch == self.policy['platform'], 'fixed-linux-recipe')
        require(request.network_policy is None and request.credential_proxy is None
                and request.lifecycle is None and not request.secure_access
                and request.extensions == {'bootstrap.execd.isolation': 'enable'}, 'unsupported-feature')
        require(type(request.timeout) is int and 60 <= request.timeout <= 600, 'fixed-ttl-bounds')
        volumes = request.volumes or []
        require(len(volumes) in (3, 4), 'host-bind-bounds')
        allowed = self.service.app_config.storage.allowed_host_paths
        if historical:
            require(len(volumes) == 3, 'historical-host-bind-bounds')
        else:
            self._fixed_host_bind_agreement(volumes, allowed)
        for volume in request.volumes or []:
            require(volume.host is not None and volume.pvc is None and volume.ossfs is None, 'non-host-volume')
            selected = volume.host.path
            require(selected.startswith('/') and os.path.normpath(selected) == selected
                    and any(selected == root or selected.startswith(root.rstrip('/') + '/') for root in allowed), 'host-bind-source')
        require(set(request.metadata or {}) == {'pe-allocation', 'pe-scope', 'pe-recipe'}, 'original-label-set')
        return binding(sid, self.assert_generation(), self.sha,
                       {'opensandbox.io/id': sid, **request.metadata}, '0' if historical else str(max(0, int(time.time()) - 2)))

    def assert_original(self, record):
        require(record['generation'] == self.assert_generation() and record['policy'] == self.sha,
                'original-owner-changed')
        require(record['profile'] == 'linux-fixed-host-bind-v1', 'unsupported-profile')

    def historical_request(self, item):
        witness = item['requestEvidence']
        require(set(witness) == {'kind', 'path', 'sha256'}, 'request-evidence-fields')
        expected = '/work/original-create-request.json' if witness['kind'] == 'retained-wire-v1' else '/work/original-derived-recipe.json'
        require(witness['path'] == expected, 'request-evidence-path')
        raw = read_file(Path(witness['path']), 16384, 0, (0o400, 0o440, 0o444))
        require(hashlib.sha256(raw).hexdigest() == witness['sha256'], 'request-evidence-pin')
        if witness['kind'] == 'retained-wire-v1':
            return CreateSandboxRequest.model_validate_json(raw)
        require(witness['kind'] == 'derived-fixed-creator-v1', 'request-evidence-kind')
        value = decode(raw)
        require(set(value) == {'kind', 'creatorFile', 'creatorSha256', 'lifecycle', 'scopeVector',
                              'hostSources', 'originalInputs'}
                and value['kind'] == 'derived-fixed-creator-v1', 'derived-fields')
        require(value['creatorFile'] == '/work/frozen-sdk-lifecycle.ts'
                and value['creatorSha256'] == FIXED_CREATOR_SHA, 'fixed-creator')
        creator = read_file(Path(value['creatorFile']), 32768, 0, (0o400, 0o440, 0o444))
        require(hashlib.sha256(creator).hexdigest() == FIXED_CREATOR_SHA, 'creator-bytes')
        lifecycle = value['lifecycle']
        require(set(lifecycle) == {'imageDigest', 'payloadSha256', 'entrypoint', 'platform', 'cpuCores',
                                   'memoryMiB', 'ttlSeconds'}, 'derived-lifecycle')
        require(lifecycle['imageDigest'] == self.policy['image'] and lifecycle['entrypoint'] == self.policy['entrypoint']
                and lifecycle['platform'] == self.policy['platform']
                and type(lifecycle['memoryMiB']) is int and 0 < lifecycle['memoryMiB'] <= 2147483647
                and type(lifecycle['ttlSeconds']) is int and 0 < lifecycle['ttlSeconds'] <= 120
                and type(lifecycle['cpuCores']) in (int, float) and 0 < lifecycle['cpuCores'] <= 2147483647,
                'derived-recipe')
        def label(raw):
            return 'h' + base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip('=') + 'h'
        def js_array(value):
            # This pinned creator hashes primitive arrays, never objects. Preserve
            # epoch string-vs-number types and normalize integral numeric CPU.
            value = [int(x) if type(x) is float and x.is_integer() else x for x in value]
            return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        scope = value['scopeVector']
        require(isinstance(scope, list) and len(scope) == 10 and isinstance(scope[0], str)
                and all(type(x) in (str, int) for x in scope), 'derived-scope')
        recipe = [lifecycle['imageDigest'], lifecycle['payloadSha256'], lifecycle['entrypoint'], lifecycle['platform'],
                  lifecycle['cpuCores'], lifecycle['memoryMiB'], lifecycle['ttlSeconds'], 'bootstrap.execd.isolation=enable']
        metadata = {'pe-allocation': label(scope[0].encode()), 'pe-scope': label(js_array(scope)),
                    'pe-recipe': label(js_array(recipe))}
        sources = value['hostSources']
        require(isinstance(sources, list) and len(sources) == 3
                and all(isinstance(x, str) for x in sources), 'derived-host-input')
        refs = value['originalInputs']
        expected = {'deployment': '/work/original-root-deployment.json',
                    'intent': '/work/original-allocation-intent.json',
                    'mount': '/work/original-mount-bindings.json'}
        require(set(refs) == set(expected), 'derived-original-input')
        originals = {}
        for key, path in expected.items():
            ref = refs[key]
            require(set(ref) == {'path', 'sha256'} and ref['path'] == path, 'derived-input-path')
            original = read_file(Path(path), 32768, 0, (0o400, 0o440, 0o444))
            require(hashlib.sha256(original).hexdigest() == ref['sha256'], 'derived-input-bytes')
            originals[key] = decode(original)
        original_lifecycle = originals['deployment']['lifecycle']
        require(all(original_lifecycle[k] == v for k, v in lifecycle.items())
                and hashlib.sha256(original_lifecycle['apiKey'].encode()).hexdigest() == self.policy['apiKeySha256'],
                'derived-original-deployment')
        order = ['allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId', 'environmentVersion',
                 'provider', 'projectMountVersion', 'requestedAt', 'createDeadlineAt']
        require([originals['intent'][k] for k in order] == scope, 'derived-original-intent')
        exports = originals['mount']['exports']
        require([exports[k] for k in ['project', 'protectedProject', 'environment']] == sources, 'derived-original-mount')
        # This is an internal whitelist projection for a specifically pinned
        # creator, not a reconstructed/retained POST wire request.
        return SimpleNamespace(image=SimpleNamespace(uri=lifecycle['imageDigest'], auth=None),
            snapshot_id=None, template_id=None, resource_requests=None, env={}, entrypoint=lifecycle['entrypoint'],
            platform=SimpleNamespace(os='linux', arch=lifecycle['platform']), timeout=lifecycle['ttlSeconds'],
            network_policy=None, credential_proxy=None, lifecycle=None, secure_access=False,
            extensions={'bootstrap.execd.isolation': 'enable'}, metadata=metadata,
            volumes=[SimpleNamespace(host=SimpleNamespace(path=p), pvc=None, ossfs=None) for p in sources])

    def retained_history(self, record):
        matches = [item for item in self.policy['historical'] if item['sandboxId'] == record['sid']]
        if not matches:
            return self._fresh_actual_history(record)
        require(len(matches) == 1 and matches[0]['containerId'] == record['cid'], 'no-original-history')
        item = matches[0]
        require(item['historyPath'] == '/work/original-history.jsonl', 'history-path')
        raw = read_file(Path(item['historyPath']), 65536, 0, (0o400, 0o440, 0o444))
        require(hashlib.sha256(raw).hexdigest() == item['historySha256'] == record['history'], 'history-pin')
        return raw

    def requires_full_history(self, record):
        # Imported pre-upgrade resources have no contemporaneous record from
        # this code: their actual complete positive chain remains mandatory.
        return any(x['sandboxId'] == record['sid'] for x in self.policy['historical'])

    def _fresh_actual_history(self, record):
        self.assert_original(record)
        api = self.service.docker_client.api
        # Same existing Unix adapter and public Engine GET/events API. Unlike
        # docker-py events(timeout=None), this read has explicit finite I/O,
        # an immutable past 'until', byte/item bounds and actual response close.
        until_seconds, until_nanos = divmod(time.time_ns(), 1_000_000_000)
        params = {'since': record['since'],
                  'until': f'{until_seconds}.{until_nanos:09d}',
                  'filters': json.dumps({'type': ['container'], 'container': [record['cid']]})}
        deadline = time.monotonic() + 6
        response = api.get(api._url('/events'), params=params, stream=True, timeout=(1, 2),
                           allow_redirects=False)
        chunks = []; count = 0
        try:
            require(response.status_code == 200 and not response.is_redirect, 'history-http')
            for chunk in response.iter_content(chunk_size=4096):
                require(time.monotonic() < deadline, 'history-time-bound')
                count += len(chunk)
                require(count <= 65536, 'history-byte-bound')
                chunks.append(chunk)
            raw = b''.join(chunks)
            require(time.monotonic() < deadline and len(raw.splitlines()) <= 64, 'history-time-item-bound')
        finally:
            response.close()
        self.assert_original(record)
        return raw

    def assert_absent_and_cleanup(self, record):
        self.assert_original(record)
        cid, sid = record['cid'], record['sid']
        # Require the original parent to exist in the verified readonly cgroup2
        # view. Only ENOENT for the exact final CID is accepted here.
        parent = CGROUP / 'docker'
        require(parent.is_dir() and not parent.is_symlink(), 'cgroup-parent')
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                os.stat(cid, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise CompletionUnknown('original-cgroup-present')
        finally:
            os.close(fd)
        try:
            self.service.docker_client.containers.get(cid)
        except NotFound:
            pass
        else:
            raise CompletionUnknown('original-container-present')
        for key in ('opensandbox.io/id', 'opensandbox.io/egress-sidecar-for'):
            rows = self.service.docker_client.containers.list(all=True, sparse=True, limit=2,
                                                             filters={'label': key + '=' + sid})
            require(len(rows) == 0, 'original-or-auxiliary-container-present')
        # The supported real request excludes PVC/OSSFS/Windows/egress and named
        # volumes. A surviving runtime auxiliary volume is an uncertainty, never
        # a reason to remove an unqualified volume or silently claim cleanup.
        try:
            self.service.docker_client.api.inspect_volume('opensandbox-runtime-' + sid)
        except NotFound:
            pass
        else:
            raise CompletionUnknown('auxiliary-volume-present')
        require(not self.service._ossfs_mount_ref_counts, 'unsupported-ossfs-state')
        metadata = self.service._metadata_store
        for path in (metadata._sandbox_path(sid), metadata._expiration_path(sid)):
            require(not path.exists() and not path.is_symlink(), 'metadata-cleanup-unsettled')
        self.assert_original(record)
        return digest({'sid': sid, 'cid': cid, 'generation': record['generation'],
                       'profile': record['profile'], 'qualifiedAuxiliarySet': 'empty'})


def install_completion(service):
    path = service.app_config.docker.deletion_completion_policy
    sha = service.app_config.docker.deletion_completion_sha256
    require((path is None) == (sha is None), 'completion-config-pair')
    if path is None:
        return
    service._deletion_view = OriginalDockerView(service, path, sha)
    service._deletion_records = CompletionRecords(Path('/work/deletion-completions'))
    # Root's protected allowlist is not a stop receipt. Historical import must
    # validate retained wire OR the explicitly derived fixed-creator projection,
    # plus actual positive history. Derived request evidence is not accepted as a live creation here.
    for item in service._deletion_view.policy['historical']:
        require(set(item) == {'sandboxId', 'containerId', 'historyPath', 'historySha256',
                             'requestEvidence'}, 'historical-binding')
        request = service._deletion_view.historical_request(item)
        selected = service._deletion_view.request_binding(item['sandboxId'], request, historical=True)
        candidate = {'cid': item['containerId'], 'history': item['historySha256'], **selected}
        verify_history(service._deletion_view.retained_history(candidate), candidate)
        service._deletion_records.reserve(selected)
        service._deletion_records.bind(item['sandboxId'], item['containerId'], history=item['historySha256'])
