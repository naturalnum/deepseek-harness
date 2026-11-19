"""Pure fixed installation profile and bounded wire helpers; no resources at import or user-selected limits."""
import base64
import binascii
import hashlib
import hmac
import json
import re
from types import MappingProxyType

from paths import absolute

VERSION = 's6-stream/2-native-pipes-pty-v1'
ROLE_DOMAIN = b'dsh:s4:range-role:v1'
RECORD_SETTLEMENT_VERSION = 1
SERVICE_WINDOW_VERSION = 1
RESIDENCE_VERSION = 1
MAX_RESIDENCE_MS = 900000
MAX_RESIDENCE_GRANTS = 32
MAX_RESIDENCE_SEGMENT_MS = 600000
MAX_RECORD_SEQUENCE = 640
RECORD_START_WINDOW_MS = 100
ROLES = ['foreground', 'service', 'program']
AUTH_HEADER = 'x-pe-execution-token'
STREAM_VERSION = 'pe-execution-stream-v1'
STREAM_CONTROL_MAX = 8388608
STREAM_LOG_MAX = 8388608
MAX_BODY, MAX_REPLY, MAX_TAIL, MAX_OBSERVED = 12288, 16384, 4096, 65536
LIMITS = MappingProxyType({
    'lifetimeOperations': 4, 'activeRanges': 2, 'tailBytesPerStream': MAX_TAIL,
    'observedStopThresholdPerStream': MAX_OBSERVED, 'prepareMs': 3000, 'preparedLeaseMs': 3000,
    'runMs': 150000, 'serviceRunMs': 120000, 'stopMs': 2000, 'residentMs': 300000,
    'childCpuSeconds': 600, 'childAddressBytes': 17179869184, 'childFileBytes': 134217728,
    'childOpenFiles': 256, 'childProcesses': 2048, 'childCoreBytes': 0,
})
HEX = re.compile(r'[0-9a-f]{64}\Z')
IDENTIFIER = re.compile(r'[A-Za-z0-9_-]{1,64}\Z')


class Refused(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__(code)


def require(ok, code='invalid_schema', status=400):
    if not ok:
        raise Refused(status, code)


def keys(value, expected):
    require(type(value) is dict and set(value) == set(expected))


def hex64(value):
    require(type(value) is str and HEX.fullmatch(value) is not None)
    return value


def offset(value):
    require(type(value) is int and 0 <= value <= 2**53 - 1, 'invalid_offset')
    return value


def dumps(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def loads(data, max_bytes=MAX_BODY):
    require(type(data) is bytes and len(data) <= max_bytes, 'body_budget', 413)
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    def constant(_):
        raise Refused(400, 'nonfinite_json')
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise Refused(400, 'invalid_json') from None


def canonical(spec):
    pipes = type(spec) is dict and spec.get('executionKind') == 'pipes'
    keys(spec, ['argv', 'stdin', 'cwd'] + (['executionKind', 'env', 'stream'] if pipes else []))
    try:
        absolute(spec['cwd'])
    except ValueError:
        raise Refused(400, 'invalid_cwd') from None
    argv = spec['argv']
    require(type(argv) is list and 1 <= len(argv) <= 16)
    require(all(type(x) is str and '\0' not in x for x in argv))
    try:
        size = sum(len(x.encode('utf-8')) + 1 for x in argv)
    except UnicodeError:
        raise Refused(400, 'invalid_argv_encoding') from None
    require(argv[0].startswith('/') and size <= 4096, 'argv_budget')
    stdin = spec['stdin']
    require(type(stdin) is dict and stdin.get('mode') in (['ignore', 'batch', 'pipe'] if pipes else ['ignore', 'batch']), 'unsupported_mode')
    if stdin['mode'] in ['ignore', 'pipe']:
        keys(stdin, ['mode'])
        batch = b''
    else:
        keys(stdin, ['mode', 'base64'])
        encoded = stdin['base64']
        require(type(encoded) is str and len(encoded) <= 5464, 'stdin_budget')
        try:
            batch = base64.b64decode(encoded.encode('ascii'), validate=True)
        except (UnicodeError, ValueError, binascii.Error):
            raise Refused(400, 'invalid_stdin_base64') from None
        require(len(batch) <= 4096 and base64.b64encode(batch).decode('ascii') == encoded, 'invalid_stdin_base64')
    normalized = {'argv': argv[:], 'stdin': dict(stdin), 'cwd': spec['cwd']}
    if pipes:
        normalized.update(executionKind='pipes', env=environment(spec['env']), stream=stream_spec(spec['stream']))
    return normalized, batch, hashlib.sha256(dumps(normalized)).hexdigest()


def environment(value):
    require(type(value) is dict and len(value) <= 128, 'environment_budget')
    for name, content in value.items():
        require(type(name) is str and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', name) is not None
                and name != 'DSH_SUBPROCESS_CONTROL', 'environment_name')
        require(content is None or type(content) is str and '\0' not in content, 'environment_value')
        if content is not None:
            try:
                content.encode('utf-8')
            except UnicodeError:
                raise Refused(400, 'environment_encoding') from None
    try:
        require(len(dumps(value)) <= 4096, 'environment_budget')
    except UnicodeError:
        raise Refused(400, 'environment_encoding') from None
    return dict(value)


def stream_spec(value):
    keys(value, ['version', 'stdout', 'stderr', 'control', 'limits']
         + [name for name in ('terminal', 'logOutputBytes') if name in value])
    if 'terminal' in value:
        terminal = value['terminal']
        keys(terminal, ['rows', 'cols'])
        require(all(type(x) is int and 1 <= x <= 65535 for x in terminal.values()), 'terminal_dimensions')
        require(value['control'] == value['stdout'] == value['stderr'] == 'pipe', 'terminal_pipes')
    require(value['version'] == STREAM_VERSION, 'stream_version')
    for name in ['stdout', 'stderr', 'control']:
        require(value[name] in ['pipe', 'ignore'], 'stream_disposition')
    if 'logOutputBytes' in value:
        limit = value['logOutputBytes']
        require(type(limit) is int and MAX_OBSERVED < limit <= STREAM_LOG_MAX, 'stream_log_budget')
        require('terminal' not in value and value['stdout'] == value['stderr'] == 'pipe'
                and value['control'] == 'ignore', 'stream_log_disposition')
    keys(value['limits'], ['controlInputBytes', 'controlOutputBytes'])
    for limit in value['limits'].values():
        require(type(limit) is int and 1 <= limit <= STREAM_CONTROL_MAX, 'stream_budget')
    return {**value, 'limits': dict(value['limits'])}


def authorization(value):
    keys(value, ['role', 'registrationId', 'signature'])
    require(type(value['role']) is str and value['role'] in ROLES, 'invalid_role')
    registration = value['registrationId']
    require((value['role'] in ['foreground', 'program'] and registration is None)
            or (value['role'] == 'service' and type(registration) is str
                and IDENTIFIER.fullmatch(registration) is not None), 'invalid_role_registration')
    hex64(value['signature'])
    return value


def file_policy(value):
    keys(value, ['mode'])
    require(value['mode'] in ['read-only', 'workspace-write', 'danger-full-access'], 'invalid_file_policy')
    return dict(value)


def verify_role(body, token):
    """Root's existing protected token signs the role; argv/spec never select it."""
    grant = authorization(body['authorization'])
    payload = {'protocolVersion': VERSION, 'runtimeIdentity': body['runtimeIdentity'],
               'operationId': body['operationId'], 'specHash': body['specHash'],
               'role': grant['role'], 'registrationId': grant['registrationId']}
    if 'recordSequence' in body:
        payload.update(recordSequence=body['recordSequence'], recordSettlementVersion=RECORD_SETTLEMENT_VERSION)
    key = hmac.digest(bytes.fromhex(hex64(token)), ROLE_DOMAIN, 'sha256')
    signature = hmac.new(key, dumps(payload), hashlib.sha256).hexdigest()
    require(hmac.compare_digest(grant['signature'], signature), 'role_authorization', 403)


def verify_settlement(body, token):
    payload = {k: body[k] for k in ['runtimeIdentity', 'operationId', 'specHash', 'recordSequence', 'authorization']}
    payload.update(protocolVersion=VERSION, recordSettlementVersion=RECORD_SETTLEMENT_VERSION, action='/settle')
    key = hmac.digest(bytes.fromhex(hex64(token)), ROLE_DOMAIN, 'sha256')
    signature = hmac.new(key, dumps(payload), hashlib.sha256).hexdigest()
    require(hmac.compare_digest(body['settlementProof'], signature), 'settlement_authorization', 403)


def verify_service_window(body, token):
    payload = {k: body[k] for k in ['runtimeIdentity', 'operationId', 'specHash', 'authorization', 'runMs']}
    payload.update(protocolVersion=VERSION, serviceWindowVersion=SERVICE_WINDOW_VERSION, action='/extend-service')
    key = hmac.digest(bytes.fromhex(hex64(token)), ROLE_DOMAIN, 'sha256')
    signature = hmac.new(key, dumps(payload), hashlib.sha256).hexdigest()
    require(hmac.compare_digest(body['windowProof'], signature), 'window_authorization', 403)


def verify_residence(body, token):
    payload = {name: value for name, value in body.items() if name != 'residenceProof'}
    payload.update(protocolVersion=VERSION, residenceVersion=RESIDENCE_VERSION, action='/renew-residence')
    key = hmac.digest(bytes.fromhex(hex64(token)), ROLE_DOMAIN, 'sha256')
    expected = hmac.new(key, dumps(payload), hashlib.sha256).hexdigest()
    require(hmac.compare_digest(body['residenceProof'], expected), 'residence_authorization', 403)


def request(path, body, runtime):
    require(type(body) is dict and body.get('runtimeIdentity') == runtime, 'runtime_mismatch', 409)
    common = ['runtimeIdentity']
    if path in ['/handshake', '/seal']:
        keys(body, common)
    elif path in ['/prepare', '/commit', '/cancel', '/poll', '/stop', '/stream', '/settle', '/extend-service', '/renew-residence']:
        sequenced = 'recordSequence' in body
        fields = common + ['operationId', 'specHash', 'authorization']
        if sequenced:
            fields += ['recordSequence']
        if path == '/settle':
            fields += ['settlementProof']
            require(sequenced, 'settlement_sequence_required')
        if path == '/extend-service':
            fields += ['runMs', 'windowProof']
        if path == '/renew-residence':
            fields += ['leaseSequence', 'residentCapMs', 'runCapMs', 'remainingMs', 'residenceProof']
        if path == '/prepare':
            fields += ['spec'] + (['skillWorld'] if 'skillWorld' in body else []) + (['filePolicy'] if 'filePolicy' in body else [])
        if path == '/poll':
            fields += ['stdoutOffset', 'stderrOffset']
        keys(body, fields)
        require(type(body['operationId']) is str and IDENTIFIER.fullmatch(body['operationId']) is not None)
        hex64(body['specHash'])
        authorization(body['authorization'])
        if sequenced:
            require(type(body['recordSequence']) is int and 1 <= body['recordSequence'] <= MAX_RECORD_SEQUENCE
                    and body['authorization']['role'] == 'foreground', 'settlement_sequence')
        if path == '/settle':
            hex64(body['settlementProof'])
        if path == '/extend-service':
            require(not sequenced and body['authorization']['role'] == 'service' and type(body['runMs']) is int
                    and LIMITS['serviceRunMs'] < body['runMs'] <= LIMITS['runMs'], 'service_window')
            hex64(body['windowProof'])
        if path == '/renew-residence':
            base = LIMITS['serviceRunMs'] if body['authorization']['role'] == 'service' else LIMITS['runMs']
            require(body['authorization']['role'] in ['service', 'foreground']
                    and type(body['leaseSequence']) is int and 1 <= body['leaseSequence'] <= MAX_RESIDENCE_GRANTS
                    and type(body['residentCapMs']) is int and LIMITS['residentMs'] < body['residentCapMs'] <= MAX_RESIDENCE_MS
                    and type(body['runCapMs']) is int and base <= body['runCapMs'] <= body['residentCapMs'] - LIMITS['stopMs']
                    and type(body['remainingMs']) is int and LIMITS['stopMs'] < body['remainingMs'] <= MAX_RESIDENCE_SEGMENT_MS,
                    'residence_window')
            hex64(body['residenceProof'])
        if path == '/prepare':
            normalized, _, _ = canonical(body['spec'])
            require(not sequenced or normalized.get('executionKind') != 'pipes'
                    or 'logOutputBytes' in normalized['stream'], 'settlement_collect_required')
            fixed = skill_world(body['skillWorld']) if 'skillWorld' in body else None
            policy = file_policy(body['filePolicy']) if 'filePolicy' in body else None
            require(prepared_digest(normalized, fixed, policy) == body['specHash'], 'spec_hash_mismatch')
        if path == '/poll':
            offset(body['stdoutOffset']); offset(body['stderrOffset'])
    else:
        raise Refused(404, 'unknown_route')
    return body


def collect(observed, tail, requested, eof):
    offset(requested)
    require(requested <= observed, 'offset_ahead', 409)
    assert 0 <= len(tail) <= MAX_TAIL and observed >= len(tail)
    start = max(requested, observed - len(tail))
    data = bytes(tail[start - (observed - len(tail)):])
    return {'requestedOffset': requested, 'startOffset': start, 'endOffset': observed, 'observedBytes': observed,
            'base64': base64.b64encode(data).decode('ascii'), 'lossy': requested < observed - len(tail), 'eof': eof}


def skill_parent(value):
    keys(value, ['metadata', 'skills', 'maxCopies'])
    def identity(item):
        keys(item, ['device', 'inode'])
        for name in ['device', 'inode']:
            text = item[name]
            require(type(text) is str and 1 <= len(text) <= 20 and text.isascii() and text.isdecimal()
                    and (text == '0' or text[0] != '0') and int(text) <= 2**64 - 1
                    and (name == 'device' or text != '0'), 'skill_identity')
        return dict(item)
    metadata, skills = identity(value['metadata']), identity(value['skills'])
    require(metadata['device'] == skills['device'] and metadata['inode'] != skills['inode']
            and type(value['maxCopies']) is int and 1 <= value['maxCopies'] <= 2147483647, 'skill_parent')
    return {'metadata': metadata, 'skills': skills, 'maxCopies': value['maxCopies']}


def skill_world(value):
    keys(value, ['metadata', 'skills', 'maxCopies', 'copies'])
    parent = skill_parent({k: value[k] for k in ['metadata', 'skills', 'maxCopies']})
    require(type(value['copies']) is list and len(value['copies']) <= parent['maxCopies'], 'skill_copies')
    copies, names = [], set()
    for entry in value['copies']:
        keys(entry, ['version', 'identity'])
        version = entry['version']
        require(type(version) is str and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', version) is not None
                and version not in names, 'skill_version')
        names.add(version)
        identity = skill_parent({'metadata': parent['metadata'], 'skills': entry['identity'], 'maxCopies': parent['maxCopies']})['skills']
        require(identity['device'] == parent['skills']['device'] and identity['inode'] != parent['skills']['inode'], 'skill_copy_domain')
        copies.append({'version': version, 'identity': identity})
    return {**parent, 'copies': copies}


def prepared_digest(spec, working_copies=None, policy=None):
    value = spec if working_copies is None and policy is None else {
        'spec': spec,
        **({} if working_copies is None else {'skillWorld': working_copies}),
        **({} if policy is None else {'filePolicy': file_policy(policy)})}
    return hashlib.sha256(dumps(value)).hexdigest()
