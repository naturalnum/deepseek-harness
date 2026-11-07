"""Exercise the supplied local Git through Python with the original six child limits."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import subprocess
import sys
import tempfile


LIMITS = {'cpu': (resource.RLIMIT_CPU, 75), 'address': (resource.RLIMIT_AS, 536870912),
          'file': (resource.RLIMIT_FSIZE, 67108864), 'descriptors': (resource.RLIMIT_NOFILE, 32),
          'processes': (resource.RLIMIT_NPROC, 32), 'core': (resource.RLIMIT_CORE, 0)}


def child_limits():
    for kind, value in LIMITS.values():
        resource.setrlimit(kind, (value, value))


def qualify(git, directory):
    if sys.executable != '/opt/dsh/research/python/bin/python3' or sys.version_info[:2] != (3, 13):
        raise RuntimeError('Git qualification requires the supplied scientific interpreter')
    actual = {name: list(resource.getrlimit(kind)) for name, (kind, _) in LIMITS.items()}
    if any(actual[name] != [value, value] for name, (_, value) in LIMITS.items()):
        raise RuntimeError('Git qualification requires the six original exact child limits')
    calls = []
    def run(*args, cwd=None):
        result = subprocess.run([str(git), '--no-pager', '-c', 'core.fsmonitor=false',
                                 '-c', 'user.name=Research fixture', '-c', 'user.email=fixture@localhost', *args],
                                cwd=cwd or directory, stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=15)
        calls.append({'operation': args[0], 'exitCode': result.returncode,
                      'stdoutBytes': len(result.stdout.encode()), 'stderrBytes': len(result.stderr.encode())})
        if result.returncode != 0:
            raise RuntimeError('Git ' + args[0] + ' failed: ' + result.stderr[:4096])
        return result.stdout
    version = run('--version').strip()
    if version != 'git version 2.47.3' or run('--exec-path').strip() != '/opt/dsh/research/git/usr/lib/git-core':
        raise RuntimeError('Git executable or independent helper prefix differs')
    repo = directory / 'repo'
    run('init', '-q', '-b', 'main', str(repo))
    if run('status', '--porcelain=v1', cwd=repo):
        raise RuntimeError('Fresh Git repository is not clean')
    names = ['input-' + str(i) + '.txt' for i in range(8)]
    for name in names:
        (repo / name).write_text('synthetic input\n')
    run('add', '--', *names, cwd=repo)
    message = 'Synthetic long-message qualification\n\n' + '长消息 / qualified Git history\n' * 200
    message_file = directory / 'message.txt'
    message_file.write_text(message)
    run('commit', '-q', '-F', str(message_file), cwd=repo)
    head = run('rev-parse', 'HEAD', cwd=repo).strip()
    if run('show-ref', '--heads', cwd=repo).split()[0] != head:
        raise RuntimeError('Git branch reference does not identify its real commit')
    for index in range(3):
        (repo / names[index]).write_text('synthetic revision ' + str(index) + '\n')
        run('add', '--', names[index], cwd=repo)
        run('commit', '-q', '-m', 'Synthetic revision ' + str(index), cwd=repo)
    history = run('log', '-4', '--format=%H%n%B', cwd=repo)
    patch = run('show', '--format=fuller', '--patch', head, cwd=repo)
    if len(history.encode()) <= 4096 or len(patch.encode()) <= 4096 or message.strip() not in history:
        raise RuntimeError('Git long history/patch qualification is incomplete')
    worktree = directory / 'branch'
    run('worktree', 'add', '-b', 'research/qualification', str(worktree), 'HEAD', cwd=repo)
    (worktree / 'branch.txt').write_text('synthetic branch content\n')
    run('add', '--', 'branch.txt', cwd=worktree)
    run('commit', '-q', '-m', 'Synthetic branch', cwd=worktree)
    run('merge', '--no-ff', '--no-edit', 'research/qualification', cwd=repo)
    merge = run('rev-parse', 'HEAD', cwd=repo).strip()
    run('revert', '--no-edit', '-m', '1', merge, cwd=repo)
    if (repo / 'branch.txt').exists() or run('status', '--porcelain=v1', cwd=repo):
        raise RuntimeError('Git merge/revert did not restore a clean worktree')
    run('worktree', 'remove', str(worktree), cwd=repo)
    return {'version': version, 'executable': str(git), 'python': sys.executable, 'pythonVersion': sys.version.split()[0],
            'pid': os.getpid(), 'pgid': os.getpgrp(), 'uid': os.getuid(), 'gid': os.getgid(), 'groups': os.getgroups(), 'limits': actual,
            'historyBytes': len(history.encode()), 'historySha256': hashlib.sha256(history.encode()).hexdigest(),
            'patchBytes': len(patch.encode()), 'commands': calls, 'clean': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--git', type=Path, default=Path('/opt/dsh/research/git/bin/git'))
    parser.add_argument('--python', type=Path, default=Path('/opt/dsh/research/python/bin/python3'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--worker', type=Path)
    parser.add_argument('--managed', action='store_true')
    args = parser.parse_args()
    if args.worker is not None:
        result = qualify(args.git, args.worker)
    elif args.managed:
        facts = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
        if (facts['NoNewPrivs'].strip() != '1' or facts['Seccomp'].strip() != '2'
                or any(int(facts[name], 16) for name in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
                or not os.statvfs('/').f_flag & os.ST_RDONLY):
            raise RuntimeError('Managed Git qualification requires the actual original business guard')
        with tempfile.TemporaryDirectory(prefix='research-git-qa-') as temporary:
            result = qualify(args.git, Path(temporary))
        result['qualification'] = 'original-managed-guard-and-local-git-operations'
    else:
        with tempfile.TemporaryDirectory(prefix='research-git-qa-') as temporary:
            root = Path(temporary)
            script = root / 'probe.py'
            shutil.copyfile(__file__, script)
            os.chmod(root, 0o700)
            os.chown(root, 2000, 2000)
            os.chown(script, 2000, 2000)
            env = {'PATH': '/usr/bin:/bin', 'HOME': str(root), 'LANG': 'C.UTF-8', 'TMPDIR': str(root)}
            child = subprocess.Popen([str(args.python), '-I', '-S', '-B', str(script), '--git', str(args.git), '--worker', str(root)],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     env=env, user=2000, group=2000, extra_groups=[], preexec_fn=child_limits,
                                     start_new_session=True)
            try:
                stdout, stderr = child.communicate(timeout=60)
            except BaseException:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
                raise
            if child.returncode != 0 or stderr or len(stdout) > 65536:
                raise RuntimeError('Git build qualification failed: ' + stderr.decode(errors='replace')[:4096])
            result = json.loads(stdout)
            result['qualification'] = 'image-build-child-limits-and-local-git-operations-not-managed-session'
    if args.output is not None:
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
