"""Original-source and deletion receipt checks without SDK or Docker imports."""
import ast
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

RUNTIME = Path(__file__).resolve().parents[1] / 'runtime'
ARM = ('0fc274e60c4b606db202dc9e82db60b4d944ba74bab8b6af2cd95ea28c4f8b2d', 814328, 183)
AMD = ('2eac825be98626a3a7e8daf17afdedcb65560951cb26ffaecea261f5686acb28', 734864, 62)


def definitions(relative, names):
    tree = ast.parse((RUNTIME / relative).read_bytes())
    selected = [item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name in names
                or isinstance(item, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in item.targets)]
    namespace = {}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(relative), 'exec'), namespace)
    return namespace


class RuntimeArchitecture(unittest.TestCase):
    def test_both_original_callers_choose_only_the_matching_exact_binary(self):
        for source in ['agent/launcher.py', 'bootstrap/publisher.py']:
            selected = definitions(source, {'bwrap_profile'})['bwrap_profile']
            for name in ['aarch64', 'arm64']:
                self.assertEqual(selected(name), ARM)
            for name in ['x86_64', 'amd64']:
                self.assertEqual(selected(name), AMD)
            for name in ['i386', 'riscv64', '', None, 'arm64\n']:
                with self.assertRaises(RuntimeError):
                    selected(name)

    def test_fixed_elf_does_not_accept_the_other_machine_or_format(self):
        for source in ['agent/launcher.py', 'bootstrap/publisher.py']:
            check = definitions(source, {'fixed_elf'})['fixed_elf']
            for machine in [62, 183]:
                raw = b'\x7fELF\x02\x01' + b'\0' * 12 + machine.to_bytes(2, 'little')
                self.assertTrue(check(raw, machine))
                self.assertFalse(check(raw, 183 if machine == 62 else 62))
                for changed in [raw[:19], b'bad' + raw[3:], raw[:4] + b'\x01' + raw[5:], raw[:5] + b'\x02' + raw[6:]]:
                    self.assertFalse(check(changed, machine))

    def test_complete_recipe_rejects_cross_arch_and_dependency_images(self):
        selected = definitions('server/completion_view.py', {'fixed_recipe', 'FIXED_IMAGE', 'NATIVE_AMD64_IMAGE'})
        check = selected['fixed_recipe']
        arm, amd = selected['FIXED_IMAGE'], selected['NATIVE_AMD64_IMAGE']
        self.assertTrue(check(arm, 'arm64'))
        self.assertTrue(check(amd, 'amd64'))
        for image, arch in [(arm, 'amd64'), (amd, 'arm64'), (amd, 'x86_64'), ('native:latest', 'amd64'),
                            ('sha256:b9e5cb3029d236dbfcb50823d59cc5ad77dab7efcd1fc4c5a256babcbcf78bde', 'amd64')]:
            self.assertFalse(check(image, arch))

    def test_legacy_historical_creator_is_not_replaced_by_the_current_creator(self):
        value = definitions('server/completion_view.py', {'FIXED_CREATOR_SHA'})['FIXED_CREATOR_SHA']
        self.assertEqual(value, '831b9f941abb7ef01603d8ed1ec25fb92480628033cf239279b97f12871d5a38')

    def test_original_deletion_owner_is_byte_identical(self):
        raw = (RUNTIME / 'server/deletion_completion.py').read_bytes()
        self.assertEqual(len(raw), 15786)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), '96496b09fdb4b5bf094cb34c96b24671f2ae2679a9e06234a50ad85a6ebc35a4')


class DeletionHistory(unittest.TestCase):
    def setUp(self):
        self.owner = runpy.run_path(str(RUNTIME / 'server/deletion_completion.py'))
        view = ast.parse((RUNTIME / 'server/completion_view.py').read_bytes())
        original = next(item for item in view.body if isinstance(item, ast.ClassDef) and item.name == 'OriginalDockerView')
        methods = [item for item in original.body if isinstance(item, ast.FunctionDef)
                   and item.name in ('retained_history', 'requires_full_history', '_fresh_actual_history', '_read_actual_history')]
        selected = ast.ClassDef(name='HistoryView', bases=[], keywords=[], body=methods, decorator_list=[], type_params=[])
        self.now = 0
        self.cid = 'a' * 64
        self.sid = '00000000-0000-0000-0000-000000000001'
        self.record = {'cid': self.cid, 'sid': self.sid, 'since': '8', 'history': None,
                       'labels': {'opensandbox.io/id': self.sid, 'pe-allocation': 'allocation',
                                  'pe-scope': 'scope', 'pe-recipe': 'recipe'}}
        self.calls, self.responses = [], []
        self.history = b''
        self.positive = self.events('destroy')
        scope = {**self.owner, 'time': SimpleNamespace(monotonic=lambda: self.now, time_ns=lambda: 11_000_000_000),
                 'read_file': lambda *args: self.history}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[selected], type_ignores=[])), '<selected history view>', 'exec'), scope)
        self.view = scope['HistoryView']()
        self.view.assert_original = lambda value: self.assertEqual(value['cid'], self.cid)
        self.view.policy = {'historical': []}
        self.view.service = SimpleNamespace(docker_client=SimpleNamespace(api=SimpleNamespace(_url=lambda path: path,
                                                                                             get=self.fetch)))

    def events(self, *actions, cid=None):
        return b''.join(self.owner['encode']({
            'Actor': {'ID': cid or self.cid,
                      'Attributes': {**self.record['labels'], 'opensandbox.io/platform-os': 'linux'}},
            'Type': 'container', 'Action': action, 'timeNano': offset,
        }) + b'\n' for offset, action in enumerate(actions, 1))

    def fetch(self, path, *, params, stream, timeout, allow_redirects):
        self.assertEqual(path, '/events')
        self.assertTrue(stream)
        self.assertFalse(allow_redirects)
        filters = json.loads(params['filters'])
        self.assertEqual(filters['container'], [self.cid])
        self.assertEqual(filters['type'], ['container'])
        self.calls.append((params, filters, timeout))
        raw = self.positive if 'event' in filters else self.history
        response = SimpleNamespace(status_code=200, is_redirect=False, closed=False)
        def respond(chunk_size):
            self.assertEqual(chunk_size, 4096)
            yield raw
        response.iter_content = respond
        response.close = lambda: setattr(response, 'closed', True)
        self.responses.append(response)
        return response

    def test_new_container_destroy_is_not_crowded_out_by_other_events(self):
        self.history = self.events(*(['exec_start'] * 65 + ['destroy']))
        self.assertEqual(self.view.retained_history(self.record), self.positive)
        self.assertEqual(self.calls[0][1]['event'], ['destroy'])
        self.assertFalse(self.view.requires_full_history(self.record))
        self.assertTrue(self.responses[0].closed)

    def test_existing_unfiltered_digest_replays_with_the_original_bounds(self):
        self.history = self.events('create', 'start', 'die', 'destroy')
        self.record['history'] = hashlib.sha256(self.history).hexdigest()
        self.assertEqual(self.view.retained_history(self.record), self.history)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][1]['event'], ['destroy'])
        self.assertNotIn('event', self.calls[1][1])
        self.assertEqual(self.calls[0][0]['until'], self.calls[1][0]['until'])
        self.assertTrue(all(response.closed for response in self.responses))

    def test_saved_destroy_digest_replays_without_an_unfiltered_query(self):
        self.record['history'] = hashlib.sha256(self.positive).hexdigest()
        self.assertEqual(self.view.retained_history(self.record), self.positive)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][1]['event'], ['destroy'])

    def test_legacy_retry_rejects_changed_bytes_and_exhausted_deadline(self):
        self.record['history'] = hashlib.sha256(self.events('create', 'destroy')).hexdigest()
        self.history = self.events('create', 'start', 'die', 'destroy')
        with self.assertRaisesRegex(self.owner['CompletionUnknown'], 'history-changed'):
            self.view.retained_history(self.record)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(response.closed for response in self.responses))

        self.calls.clear()
        def at_original(record):
            if self.calls:
                self.now += 3
        self.view.assert_original = at_original
        with self.assertRaisesRegex(self.owner['CompletionUnknown'], 'history-time-bound'):
            self.view.retained_history(self.record)
        self.assertEqual(len(self.calls), 1)

    def test_historical_import_still_requires_create_start_die_destroy(self):
        self.history = self.events('create', 'start', 'die', 'destroy')
        self.record['history'] = hashlib.sha256(self.history).hexdigest()
        self.view.policy['historical'] = [{'sandboxId': self.sid, 'containerId': self.cid,
                                          'historyPath': '/work/original-history.jsonl',
                                          'historySha256': self.record['history']}]
        self.assertTrue(self.view.requires_full_history(self.record))
        raw = self.view.retained_history(self.record)
        self.assertEqual(self.owner['verify_history'](raw, self.record), self.record['history'])
        self.assertEqual(self.calls, [])
        with self.assertRaisesRegex(self.owner['CompletionUnknown'], 'history-positive-event'):
            self.owner['verify_history'](self.positive, self.record)

    def test_fresh_history_does_not_accept_absence_or_another_container(self):
        for raw, pattern in [(b'', 'history-bounds'), (self.events('destroy', cid='b' * 64), 'history-identity')]:
            with self.subTest(pattern=pattern):
                self.positive = raw
                observed = self.view.retained_history(self.record)
                expected = {**self.record, 'history': hashlib.sha256(observed).hexdigest()}
                with self.assertRaisesRegex(self.owner['CompletionUnknown'], pattern):
                    self.owner['verify_history'](observed, expected, full_chain=False)

    def test_lost_delete_response_replays_completed_receipt_after_owner_restart(self):
        finish = self.owner['finish_original_delete']
        records = self.owner['CompletionRecords']
        removed = []
        verified = []
        self.view.assert_absent_and_cleanup = lambda record: verified.append(record['cid']) or 'd' * 64
        service = self.view.service
        service._deletion_view = self.view
        service._delete_sandbox_without_completion = lambda sid, *, expected_container_id: removed.append((sid, expected_container_id))
        # CompletionRecords checks every ancestor. A shared source checkout or
        # system temporary directory can be writable by other users.
        with TemporaryDirectory(prefix='completion-test-', dir=Path.home().resolve()) as directory:
            receipt_dir = Path(directory) / 'records'
            service._deletion_records = records(receipt_dir, uid=os.getuid(), require_domain=False)
            try:
                original = self.owner['binding'](self.sid, 'b' * 64, 'c' * 64, self.record['labels'], self.record['since'])
                service._deletion_records.reserve(original)
                service._deletion_records.bind(self.sid, self.cid)
                finish(service, self.sid)  # The application loses this response.
                committed = service._deletion_records.get(self.sid)
                self.assertEqual(committed['phase'], 'completed')
                payload = (receipt_dir / f'{self.sid}.json').read_bytes()
            finally:
                service._deletion_records.close()

            self.positive = b''  # Engine history can age out once the owner has persisted completion.
            service._deletion_records = records(receipt_dir, uid=os.getuid(), require_domain=False)
            try:
                for _ in range(2):
                    finish(service, self.sid)
                    self.assertEqual(service._deletion_records.get(self.sid), committed)
                    self.assertEqual((receipt_dir / f'{self.sid}.json').read_bytes(), payload)
            finally:
                service._deletion_records.close()
        self.assertEqual(removed, [(self.sid, self.cid)])
        self.assertEqual(verified, [self.cid] * 3)
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    if sys.argv[1:] == ['--profiles']:
        print(json.dumps({source: {platform: definitions(source, {'bwrap_profile'})['bwrap_profile'](platform)
                                  for platform in ['arm64', 'amd64']}
                          for source in ['agent/launcher.py', 'bootstrap/publisher.py']}))
    else:
        unittest.main(verbosity=2)
