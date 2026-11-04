"""Offline controls for exact owner observations, apt drift and immutable resource modes."""
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch, Mock
import install_v6
from install_v6 import parse_apt_simulation
from materialize_v6 import APT, ASSETS, SSH_BASE_IMAGE, archive_bytes, owner_inputs, wheel_filename, wheel_inputs, materialize, split_inputs
from prepare_context import sha256


class V6Tests(unittest.TestCase):
    def test_wheel_filename_keeps_only_an_existing_compatible_platform_tag(self):
        self.assertEqual(wheel_filename('fonttools-4.60.1-cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl'),
                         'fonttools-4.60.1-cp312-cp312-manylinux_2_28_aarch64.whl')
        with self.assertRaises(ValueError):
            wheel_filename('x-1.0-cp312-cp312-manylinux_2_28_x86_64.whl')

    def test_direct_url_source_and_exact_closure_are_required(self):
        manifest = {'packages': [{'wheel': 'x.whl'}] * 28}
        for url in ('https://example.org/x.whl', 'http://files.pythonhosted.org/x.whl',
                    'https://files.pythonhosted.org/x.whl?mutable=true'):
            report = {'install': [{'download_info': {'url': url}}]}
            with self.assertRaises(ValueError):
                wheel_inputs(Path('/not-read'), manifest, report)
        with self.assertRaises(ValueError):
            wheel_inputs(Path('/not-read'), manifest, {'install': []})

    def test_materializer_rejects_changed_approved_wheel_manifest_before_context_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            changed = root / 'changed.json'
            changed.write_text('{}')
            with self.assertRaisesRegex(ValueError, 'wheel-manifest digest'):
                materialize(root / 'unused', root / 'unused', root, changed, root / 'out')

    def test_already_readonly_inode_is_not_chmodded(self):
        inode = Mock()
        inode.stat.return_value.st_mode = 0o100444
        install_v6.readonly_mode(inode)
        inode.chmod.assert_not_called()
        inode.stat.return_value.st_mode = 0o100644
        install_v6.readonly_mode(inode)
        inode.chmod.assert_called_once_with(0o444)

    def test_apt_phase_uses_default_fontconfig_and_never_runs_payload(self):
        base = {'packages': [{'name': 'base', 'version': '1'}]}
        plan = {'newOrChangedPackages': [{'name': 'office-package', 'version': '2'}, {'name': 'tex-package', 'version': '3'}]}
        first = {'newOrChangedPackages': [{'name': 'office-package', 'version': '2'}],
                 'stage2RemainingChangedPackages': [{'name': 'tex-package', 'version': '3'}]}
        with (patch.object(install_v6, 'observations', return_value=(base, plan, first)),
              patch.object(install_v6, 'installed', side_effect=[{'base': '1'}, {'base': '1', 'office-package': '2'}]),
              patch.object(install_v6, 'clean_payload_preflight'),
              patch.object(install_v6, 'await_apt_commit') as checkpoint,
              patch.object(install_v6.subprocess, 'run') as run,
              patch.object(install_v6.subprocess, 'check_output', return_value='Inst office-package (2 stable [arm64])'),
              patch.object(install_v6.Path, 'iterdir', return_value=iter(())),
              patch.dict(install_v6.os.environ, {'FONTCONFIG_FILE': '/not-yet-generated'}, clear=True)):
            install_v6.install_apt('apt-office')
            self.assertNotIn('FONTCONFIG_FILE', install_v6.os.environ)
            self.assertEqual([call.args[0][0] for call in run.call_args_list], ['apt-get', 'apt-get'])
            checkpoint.assert_called_once_with('apt-office', {'base': '1', 'office-package': '2'})

    def test_payload_phase_refuses_system_stage_drift_before_creating_files(self):
        with (patch.object(install_v6, 'observations', return_value=({'packages': []},
                  {'newOrChangedPackages': [{'name': 'o', 'version': '1'}, {'name': 't', 'version': '1'}]},
                  {'newOrChangedPackages': [{'name': 'o', 'version': '1'}], 'stage2RemainingChangedPackages': [{'name': 't', 'version': '1'}]})),
              patch.object(install_v6, 'installed', return_value={'unexpected': '1'}),
              patch.object(install_v6, 'clean_payload_preflight') as preflight):
            with self.assertRaisesRegex(ValueError, 'system-stage package map'):
                install_v6.install_payload()
            preflight.assert_not_called()

    def test_commit_checkpoint_requires_this_live_nonce(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def approve(_):
                request = json.loads((root / 'apt-office-commit-request.json').read_text())
                (root / 'apt-office-commit-approval.json').write_text(json.dumps({'requestId': request['requestId'], 'phase': request['phase'],
                    'expectedPackageMapSha256': request['expectedPackageMapSha256'], 'decision': 'approve'}))
            with (patch.object(install_v6, 'installed', return_value={'fixture': '1'}),
                  patch.object(install_v6.time, 'sleep', side_effect=approve)):
                install_v6.await_apt_commit('apt-office', {'fixture': '1'}, root, 10)
            request = json.loads((root / 'apt-office-commit-request.json').read_text())
            self.assertEqual(request['requiredStoreReserveBytes'], 268435456)
            self.assertEqual(request['requiredMemoryReserveBytes'], 536870912)

    def test_preexisting_or_wrong_commit_approval_cannot_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            approval = root / 'apt-office-commit-approval.json'
            approval.write_text('{}')
            with patch.object(install_v6, 'installed', return_value={}):
                with self.assertRaisesRegex(ValueError, 'Pre-existing'):
                    install_v6.await_apt_commit('apt-office', {}, root, 10)
            approval.unlink()
            def wrong(_):
                approval.write_text(json.dumps({'requestId': 'stale', 'decision': 'approve'}))
            with (patch.object(install_v6, 'installed', return_value={}),
                  patch.object(install_v6.time, 'sleep', side_effect=wrong)):
                with self.assertRaisesRegex(ValueError, 'does not match'):
                    install_v6.await_apt_commit('apt-office', {}, root, 10)

    def test_commit_checkpoint_timeout_never_exits_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            with (patch.object(install_v6, 'installed', return_value={}),
                  patch.object(install_v6.time, 'monotonic', side_effect=[0, 901])):
                with self.assertRaises(TimeoutError):
                    install_v6.await_apt_commit('apt-office', {}, Path(tmp), 900)

    def test_phase_maps_keep_exact_intermediate_and_final_versions(self):
        base = {'packages': [{'name': 'b', 'version': '1'}]}
        full = {'newOrChangedPackages': [{'name': 'o', 'version': '2'}, {'name': 't', 'version': '3'}]}
        first = {'newOrChangedPackages': [{'name': 'o', 'version': '2'}],
                 'stage2RemainingChangedPackages': [{'name': 't', 'version': '3'}]}
        before, changed, intermediate = install_v6.phase_maps('apt-office', base, full, first)
        second_before, remaining, final = install_v6.phase_maps('apt-tex', base, full, first)
        self.assertEqual((before, changed), ({'b': '1'}, {'o': '2'}))
        self.assertEqual(intermediate, second_before)
        self.assertEqual(remaining, {'t': '3'})
        self.assertEqual(final, {'b': '1', 'o': '2', 't': '3'})
        first['stage2RemainingChangedPackages'][0]['version'] = 'wrong'
        with self.assertRaisesRegex(ValueError, 'Stage-two remainder'):
            install_v6.phase_maps('apt-tex', base, full, first)
        first['newOrChangedPackages'][0]['version'] = 'wrong'
        with self.assertRaisesRegex(ValueError, 'Stage-one mutation'):
            install_v6.phase_maps('apt-office', base, full, first)

    def test_two_fixed_commit_phases_do_not_reuse_upper_layer_approval(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ids = []
            for phase, expected in [('apt-office', {'o': '1'}), ('apt-tex', {'o': '1', 't': '2'})]:
                def approve(_, phase=phase):
                    request = json.loads((root / (phase + '-commit-request.json')).read_text())
                    response = {'requestId': request['requestId'], 'phase': phase,
                                'expectedPackageMapSha256': request['expectedPackageMapSha256'], 'decision': 'approve'}
                    (root / (phase + '-commit-approval.json')).write_text(json.dumps(response))
                with (patch.object(install_v6, 'installed', return_value=expected),
                      patch.object(install_v6.time, 'sleep', side_effect=approve)):
                    install_v6.await_apt_commit(phase, expected, root, 10)
                request = json.loads((root / (phase + '-commit-request.json')).read_text())
                self.assertEqual(request['expectedPackageMapSha256'], install_v6.map_sha256(expected))
                ids.append(request['requestId'])
            self.assertEqual(len(set(ids)), 2)

    def test_commit_phase_or_expected_map_mismatch_cannot_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def wrong_phase(_):
                request = json.loads((root / 'apt-tex-commit-request.json').read_text())
                (root / 'apt-tex-commit-approval.json').write_text(json.dumps({
                    'requestId': request['requestId'], 'phase': 'apt-office',
                    'expectedPackageMapSha256': request['expectedPackageMapSha256'], 'decision': 'approve'}))
            with (patch.object(install_v6, 'installed', return_value={}),
                  patch.object(install_v6.time, 'sleep', side_effect=wrong_phase)):
                with self.assertRaisesRegex(ValueError, 'does not match'):
                    install_v6.await_apt_commit('apt-tex', {}, root, 10)
            with patch.object(install_v6, 'installed', return_value={'unexpected': '1'}):
                with self.assertRaisesRegex(ValueError, 'map changed'):
                    install_v6.await_apt_commit('apt-office', {}, root, 10)

    def test_missing_or_changed_actual_split_inputs_refuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'ACTUAL-STAGE1-PLAN.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'stage-one plan digest'):
                split_inputs(root, root)
            with self.assertRaisesRegex(ValueError, 'required together'):
                materialize(root, root, root, root, root / 'out', observations=root)

    def test_second_phase_simulation_drift_never_installs_or_commits(self):
        base = {'packages': [{'name': 'b', 'version': '1'}]}
        full = {'newOrChangedPackages': [{'name': 'o', 'version': '2'}, {'name': 't', 'version': '3'}]}
        first = {'newOrChangedPackages': [{'name': 'o', 'version': '2'}],
                 'stage2RemainingChangedPackages': [{'name': 't', 'version': '3'}]}
        with (patch.object(install_v6, 'observations', return_value=(base, full, first)),
              patch.object(install_v6, 'installed', return_value={'b': '1', 'o': '2'}),
              patch.object(install_v6, 'clean_payload_preflight'),
              patch.object(install_v6.subprocess, 'run') as run,
              patch.object(install_v6.subprocess, 'check_output', return_value='Inst t (4 stable [arm64])'),
              patch.object(install_v6, 'await_apt_commit') as checkpoint):
            with self.assertRaisesRegex(ValueError, 'resolution differs'):
                install_v6.install_apt('apt-tex')
            self.assertEqual([call.args[0] for call in run.call_args_list], [['apt-get', 'update']])
            checkpoint.assert_not_called()

    def test_second_phase_actual_package_drift_never_reaches_commit(self):
        base = {'packages': [{'name': 'b', 'version': '1'}]}
        full = {'newOrChangedPackages': [{'name': 'o', 'version': '2'}, {'name': 't', 'version': '3'}]}
        first = {'newOrChangedPackages': [{'name': 'o', 'version': '2'}],
                 'stage2RemainingChangedPackages': [{'name': 't', 'version': '3'}]}
        for before, after in [({'b': 'wrong', 'o': '2'}, {}),
                              ({'b': '1', 'o': '2'}, {'b': '1', 'o': '2', 't': 'wrong'})]:
            with (patch.object(install_v6, 'observations', return_value=(base, full, first)),
                  patch.object(install_v6, 'installed', side_effect=[before, after]),
                  patch.object(install_v6, 'clean_payload_preflight'),
                  patch.object(install_v6.subprocess, 'run') as run,
                  patch.object(install_v6.subprocess, 'check_output', return_value='Inst t (3 stable [arm64])'),
                  patch.object(install_v6, 'await_apt_commit') as checkpoint):
                with self.assertRaises(ValueError):
                    install_v6.install_apt('apt-tex')
                checkpoint.assert_not_called()
                if before['b'] == 'wrong': run.assert_not_called()

    def fixture(self, directory):
        base_raw = ''.join('installed\t' + name + '\t1.0\n' for name in APT)
        apt_raw = 'Inst test-package (2.0 Debian:stable [arm64])\n'
        base = {'baseImage': SSH_BASE_IMAGE, 'architecture': 'arm64',
                'observationKind': 'actual-readonly-owner-observation',
                'rawEvidenceSha256': sha256(base_raw.encode()),
                'packages': [{'name': name, 'version': '1.0'} for name in APT]}
        plan = {'baseImage': SSH_BASE_IMAGE, 'architecture': 'arm64',
                'observationKind': 'actual-readonly-owner-observation',
                'rawEvidenceSha256': sha256(apt_raw.encode()), 'requestedPackages': APT,
                'newOrChangedPackages': [{'name': 'test-package', 'version': '2.0'}]}
        for name, value in (('base-dpkg', base), ('apt-plan', plan)):
            (directory / (name + '.json')).write_text(json.dumps(value))
        (directory / 'base-dpkg.raw').write_text(base_raw)
        (directory / 'apt-plan.raw').write_text(apt_raw)
        return base, plan

    def test_original_apt_output_and_architecture_qualifier(self):
        self.assertEqual(parse_apt_simulation('Inst libc6:arm64 [1.0] (2.0 Debian [arm64])\n'), {'libc6': '2.0'})

    def test_apt_removal_and_unrecognized_lines_refuse(self):
        for value in ('Remv libc6 [1.0]\n', 'Inst ??? unexpected\n'):
            with self.assertRaises(ValueError):
                parse_apt_simulation(value)

    def test_matching_fixture_records_are_accepted_without_docker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            self.assertEqual(len(owner_inputs(root)), 4)

    def test_missing_owner_records_never_materialize_as_actual(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                owner_inputs(Path(tmp))

    def test_parser_raw_digest_and_requested_functionality_drift_refuse(self):
        for field, value in (('rawEvidenceSha256', '0' * 64), ('requestedPackages', APT[:-1])):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                _, plan = self.fixture(root)
                plan[field] = value
                (root / 'apt-plan.json').write_text(json.dumps(plan))
                with self.assertRaises(ValueError):
                    owner_inputs(root)

    def test_asset_modes_are_frozen_before_copy_without_changing_bytes(self):
        name = ASSETS + 'office/SKILL.md'
        data = archive_bytes([(name, b'original bytes\n', 0o644)])
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            self.assertEqual(archive.getmember(name).mode, 0o444)
            self.assertEqual(archive.getmember(ASSETS.rstrip('/')).mode, 0o555)
            self.assertEqual(archive.extractfile(name).read(), b'original bytes\n')
        self.assertEqual(data, archive_bytes([(name, b'original bytes\n', 0o644)]))


if __name__ == '__main__':
    unittest.main()
