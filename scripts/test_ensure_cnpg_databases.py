import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('init_db', Path(__file__).with_name('ensure-cnpg-databases.py'))
init_db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(init_db)


class InitializationTests(unittest.TestCase):
    def test_manifest_uses_secret_and_bounded_job(self):
        job = init_db.manifest('test-job')
        self.assertEqual(job['spec']['backoffLimit'], 0)
        self.assertEqual(job['spec']['activeDeadlineSeconds'], 240)
        pod = job['spec']['template']['spec']
        self.assertFalse(pod['automountServiceAccountToken'])
        container = pod['containers'][0]
        self.assertEqual(container['env'][2]['valueFrom']['secretKeyRef']['name'], 'postgres-cluster-superuser')
        self.assertIn('resources', container)
        self.assertIn('affinity', pod)
        self.assertIn('\\set ON_ERROR_STOP on', container['args'][0])
        self.assertIn('pg_advisory_lock', container['args'][0])
        self.assertIn("('opsiforce'), ('bifrost')", container['args'][0])
        self.assertIn('WHERE NOT EXISTS', container['args'][0])

    @patch.object(init_db, 'kubectl')
    def test_success_comes_from_condition_not_output(self, kube):
        kube.return_value = SimpleNamespace(stdout=json.dumps({'status': {'conditions': [
            {'type': 'Complete', 'status': 'True'}]}}))
        init_db.wait_for_job('test')
        self.assertEqual(kube.call_args.args, ('get', 'job', 'test', '-o', 'json'))

    @patch.object(init_db, 'kubectl')
    def test_failed_job_stops_deployment(self, kube):
        kube.return_value = SimpleNamespace(stdout=json.dumps({'status': {'conditions': [
            {'type': 'Failed', 'status': 'True', 'message': 'authentication failed'}]}}))
        with self.assertRaisesRegex(RuntimeError, 'authentication failed'):
            init_db.wait_for_job('test')

    @patch.object(init_db.time, 'sleep')
    @patch.object(init_db, 'kubectl')
    def test_false_conditions_keep_waiting(self, kube, sleep):
        kube.side_effect = [SimpleNamespace(stdout=json.dumps({'status': {'conditions': [
            {'type': 'Complete', 'status': 'False'}]}})), SimpleNamespace(stdout=json.dumps({
                'status': {'conditions': [{'type': 'Complete', 'status': 'True'}]}}))]
        init_db.wait_for_job('test')
        sleep.assert_called_once_with(2)

    @patch.object(init_db.time, 'monotonic', side_effect=[0, 301])
    def test_timeout_is_failure(self, clock):
        with self.assertRaises(TimeoutError):
            init_db.wait_for_job('test')

    @patch.object(init_db, 'kubectl')
    @patch.object(init_db, 'wait_for_job', side_effect=RuntimeError('SQL failure'))
    def test_failure_is_preserved_and_job_cleaned_up(self, wait, kube):
        with self.assertRaisesRegex(RuntimeError, 'SQL failure'):
            init_db.main()
        commands = [call.args[0] for call in kube.call_args_list]
        self.assertEqual(commands, ['create', 'logs', 'get', 'delete'])


if __name__ == '__main__':
    unittest.main()
