"""Private bounded HTTP/1.1 subset; sole Root owner, never a thread/process per request."""
import hashlib
import hmac
import os
import selectors
import signal
import socket
import stat
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from launcher import BWRAP_HASH, Owner
from manager import Manager
from paths import ENV_ROOT, project_path
from wire import AUTH_HEADER, MAX_BODY, MAX_REPLY, Refused, dumps, hex64, keys, loads, require

ROUTES = {'/handshake', '/prepare', '/commit', '/cancel', '/poll', '/stop', '/seal'}


def parse_head(data, token):
    require(len(data) <= 4096 and data.endswith(b'\r\n\r\n'), 'header_budget', 431)
    try:
        lines = data[:-4].decode('ascii').split('\r\n')
    except UnicodeError:
        raise Refused(400, 'invalid_headers') from None
    parts = lines[0].split(' ')
    require(len(parts) == 3 and parts[0] == 'POST' and parts[2] == 'HTTP/1.1', 'unsupported_http')
    headers = {}
    for line in lines[1:]:
        key, colon, value = line.partition(':')
        require(bool(colon) and 1 <= len(key) <= 64 and key.replace('-', '').isalnum(), 'invalid_headers')
        key, value = key.lower(), value.strip(' \t')
        require(key not in headers and all(32 <= ord(c) < 127 for c in value), 'ambiguous_headers')
        headers[key] = value
    require(AUTH_HEADER in headers and hmac.compare_digest(headers[AUTH_HEADER], token), 'unauthorized', 401)
    require(parts[1] in ROUTES, 'unknown_route', 404)
    require(0 < len(headers.get('host', '')) <= 128, 'invalid_host')
    require('transfer-encoding' not in headers and 'content-encoding' not in headers and 'expect' not in headers, 'unsupported_framing')
    length = headers.get('content-length', '')
    require(length.isascii() and length.isdecimal() and len(length) <= 5, 'invalid_length')
    require(int(length) <= MAX_BODY, 'body_budget', 413)
    require(headers.get('content-type') == 'application/json', 'unsupported_content_type', 415)
    return parts[1], int(length)


def response(status, payload):
    body = dumps(payload)
    require(len(body) <= MAX_REPLY, 'reply_budget', 503)
    head = (f'HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n'
            'Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n').encode('ascii')
    return head + body


def configuration(path):
    require(path == '/root-secret/agent.json', 'invalid_config_path')
    directory = os.lstat('/root-secret')
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0 and stat.S_IMODE(directory.st_mode) == 0o700, 'private_directory_required')
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_uid == 0 and stat.S_IMODE(item.st_mode) == 0o600
                and item.st_nlink == 1 and item.st_size <= 4096, 'private_config_required')
        config = loads(os.read(fd, 4097))
    finally:
        os.close(fd)
    return checked_configuration(config)


def checked_configuration(config):
    keys(config, ['runtimeIdentity', 'token', 'listenAddress', 'port', 'declaredImageId',
                  'projectRoot', 'envRoot', 'expectedRoots'])
    hex64(config['runtimeIdentity']); hex64(config['token'])
    require(config['listenAddress'] in ['127.0.0.1', '0.0.0.0'] and type(config['port']) is int
            and 1024 <= config['port'] <= 65535, 'invalid_listen')
    require(type(config['declaredImageId']) is str and config['declaredImageId'].startswith('sha256:'), 'invalid_image_pin')
    hex64(config['declaredImageId'][7:])
    try:
        project_path(config['projectRoot'])
    except ValueError:
        raise Refused(400, 'invalid_project_root') from None
    require(config['envRoot'] == ENV_ROOT, 'fixed_env_root_required')
    keys(config['expectedRoots'], ['project', 'environment'])
    for name in ['project', 'environment']:
        row = config['expectedRoots'][name]
        keys(row, ['device', 'inode', 'grant'])
        root_decimal(row['device'], allow_zero=True); root_decimal(row['inode'])
        keys(row['grant'], ['maximumBytes', 'maximumInodes'])
        root_decimal(row['grant']['maximumBytes']); root_decimal(row['grant']['maximumInodes'])
    require(config['expectedRoots']['project']['device'] != config['expectedRoots']['environment']['device'],
            'independent_filesystems_required')
    return config


def root_decimal(value, allow_zero=False):
    require(type(value) is str and 1 <= len(value) <= 20 and value.isascii() and value.isdecimal()
            and (value == '0' or value[0] != '0') and int(value) <= 2**64 - 1
            and (allow_zero or value != '0'), 'invalid_root_decimal')
    return int(value)


def mount_facts(config):
    result = {}
    for name, path in [('project', config['projectRoot']), ('environment', ENV_ROOT)]:
        item, fs = os.lstat(path), os.statvfs(path)
        expected = config['expectedRoots'][name]
        byte_cap = root_decimal(expected['grant']['maximumBytes'])
        inode_cap = root_decimal(expected['grant']['maximumInodes'])
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == item.st_gid == 2000
                and stat.S_IMODE(item.st_mode) == 0o700, 'mount_identity')
        require(os.path.realpath(path, strict=True) == path and os.path.ismount(path)
                and [item.st_dev, item.st_ino] == [root_decimal(expected['device'], allow_zero=True),
                                                 root_decimal(expected['inode'])], 'mount_identity')
        require(fs.f_blocks * fs.f_frsize == byte_cap and fs.f_files == inode_cap, 'mount_budget')
        require(not fs.f_flag & os.ST_RDONLY, 'writable_domain_required')
        result[path] = {'device': str(item.st_dev), 'inode': str(item.st_ino), 'uid': item.st_uid, 'gid': item.st_gid,
                        'capacityBytes': str(fs.f_blocks * fs.f_frsize), 'capacityInodes': str(fs.f_files),
                        'grant': dict(expected['grant'])}
    identities = {int(result[ENV_ROOT]['inode'])}
    for name in ['home', 'venv', 'tmp']:
        path = ENV_ROOT + '/' + name
        item = os.lstat(path)
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == item.st_gid == 2000
                and stat.S_IMODE(item.st_mode) == 0o700
                and os.path.realpath(path, strict=True) == path
                and item.st_dev == int(result[ENV_ROOT]['device'])
                and item.st_ino not in identities, 'environment_layout')
        identities.add(item.st_ino)
    for path in [config['projectRoot'] + '/.pe']:
        item = os.lstat(path)
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == item.st_gid == 2000, 'world_path_required')
    return result


def kernel_roots(mounts):
    return {path: [int(facts['device']), int(facts['inode'])] for path, facts in mounts.items()}


class Server:
    def __init__(self, manager, token, listener):
        self.manager, self.token, self.listener = manager, token, listener
        self.selector, self.peers = selectors.DefaultSelector(), {}
        listener.setblocking(False)
        self.selector.register(listener, selectors.EVENT_READ, None)
        self.signal_seal = False

    def close_peer(self, sock):
        self.selector.unregister(sock)
        del self.peers[sock]
        try:
            sock.close()
        except OSError:
            self.manager.control_unknown = True
            self.manager.seal('control-close-unknown')

    def reply(self, peer, status, body):
        peer['output'], peer['sent'] = response(status, body), 0
        peer['input'].clear()
        self.selector.modify(peer['socket'], selectors.EVENT_WRITE, peer)

    def read(self, peer):
        data = peer['socket'].recv(4096)
        if not data:
            self.close_peer(peer['socket'])  # Observer disconnect never stops/commits an operation.
            return
        peer['input'].extend(data)
        require(len(peer['input']) <= 4096 + MAX_BODY, 'request_budget', 413)
        if peer['length'] is None:
            end = peer['input'].find(b'\r\n\r\n')
            if end < 0:
                require(len(peer['input']) <= 4096, 'header_budget', 431)
                return
            peer['path'], peer['length'] = parse_head(bytes(peer['input'][:end + 4]), self.token)
            peer['headerEnd'], peer['authenticated'] = end + 4, True
        total = peer['headerEnd'] + peer['length']
        require(len(peer['input']) <= total, 'pipelining_forbidden')
        if len(peer['input']) == total:
            body = bytes(peer['input'][peer['headerEnd']:])
            peer['input'].clear()  # Do not retain authentication header bytes with operation records.
            self.reply(peer, 200, self.manager.handle(peer['path'], loads(body)))

    def run(self):
        while True:
            if self.signal_seal:
                self.manager.seal('root-signal')
                self.signal_seal = False
            self.manager.tick()
            for key, mask in self.selector.select(0.01):
                if key.data is None:
                    try:
                        sock, _ = self.listener.accept()
                    except BlockingIOError:
                        continue
                    if len(self.peers) >= 4:
                        sock.close()
                        continue
                    sock.setblocking(False)
                    peer = {'socket': sock, 'input': bytearray(), 'length': None, 'headerEnd': None,
                            'authenticated': False, 'output': None, 'sent': 0, 'created': time.monotonic()}
                    self.peers[sock] = peer
                    self.selector.register(sock, selectors.EVENT_READ, peer)
                    continue
                peer, sock = key.data, key.fileobj
                try:
                    if mask & selectors.EVENT_READ:
                        self.read(peer)
                    elif mask & selectors.EVENT_WRITE:
                        peer['sent'] += sock.send(peer['output'][peer['sent']:])
                        if peer['sent'] == len(peer['output']):
                            self.close_peer(sock)
                except Refused as error:
                    payload = self.manager.envelope(error=error.code) if peer['authenticated'] else {'error': error.code}
                    self.reply(peer, error.status, payload)
                except BlockingIOError:
                    continue
                except (ConnectionError, OSError):
                    if sock in self.peers:
                        self.close_peer(sock)
                except Exception:
                    self.manager.seal('manager-failure')
                    if sock in self.peers:
                        self.reply(peer, 503, {'error': 'manager_failure'})
            for sock, peer in list(self.peers.items()):
                if time.monotonic() - peer['created'] >= 5:
                    self.close_peer(sock)


def main():
    if len(sys.argv) != 2 or not __debug__:
        raise SystemExit(125)
    config = configuration(sys.argv[1])
    mounts = mount_facts(config)
    roots = kernel_roots(mounts)
    owner = Owner(config['projectRoot'], roots)  # Same thread/SIGCHLD/hash/physical-root checks.
    manager = Manager(config['runtimeIdentity'], owner, mounts, config['declaredImageId'], config['token'])
    manager.pins = {'bwrapSha256': BWRAP_HASH, 'userWorldArgvSha256': hashlib.sha256(dumps(owner.base)).hexdigest()}
    sources = {}
    for name in ['server.py', 'wire.py', 'manager.py', 'launcher.py', 'guardian.py', 'paths.py']:
        with open(os.path.join(os.path.dirname(os.path.realpath(__file__)), name), 'rb') as f:
            data = f.read(65537)
        require(len(data) <= 65536, 'source_budget')
        sources[name] = hashlib.sha256(data).hexdigest()
    manager.pins['agentSourceSha256'] = hashlib.sha256(dumps(sources)).hexdigest()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM | socket.SOCK_CLOEXEC)
    listener.bind((config['listenAddress'], config['port']))
    listener.listen(4)
    server = Server(manager, config['token'], listener)
    for sig in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(sig, lambda *_: setattr(server, 'signal_seal', True))
    marker = os.open('/root-secret/s4-agent.started', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        os.write(marker, config['runtimeIdentity'].encode('ascii'))
        os.fsync(marker)
    finally:
        os.close(marker)  # Never removed after publication; this is not a physical-stop receipt.
    server.run()  # Seal retains records/queries until the outside Root destroys this physical allocation.


if __name__ == '__main__':
    main()
