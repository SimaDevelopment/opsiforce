#!/usr/bin/env python3
"""Initialize application databases without kubectl attach or streamed decisions."""
import json
import subprocess
import time
import uuid

SQL = r"""\set ON_ERROR_STOP on
SELECT pg_advisory_lock(739104205);
SELECT format('CREATE DATABASE %I', name)
FROM (VALUES ('opsiforce'), ('bifrost')) AS databases(name)
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = name)
\gexec
SELECT pg_advisory_unlock(739104205);
"""


def manifest(name):
    return {
        'apiVersion': 'batch/v1', 'kind': 'Job',
        'metadata': {'name': name, 'namespace': 'postgres'},
        'spec': {
            'backoffLimit': 0, 'activeDeadlineSeconds': 240,
            'ttlSecondsAfterFinished': 600,
            'template': {'spec': {
                'restartPolicy': 'Never', 'automountServiceAccountToken': False,
                # Use existing database nodes in either cloud, without region literals.
                'affinity': {'podAffinity': {'requiredDuringSchedulingIgnoredDuringExecution': [{
                    'labelSelector': {'matchLabels': {'cnpg.io/cluster': 'postgres-cluster'}},
                    'topologyKey': 'kubernetes.io/hostname',
                }]}},
                'containers': [{
                    'name': 'init', 'image': 'postgres:16',
                    'command': ['sh', '-ec'],
                    'args': ["psql -X --no-password --host=postgres-cluster-rw.postgres.svc.cluster.local "
                             "--username=postgres --dbname=postgres <<'SQL'\n" + SQL + 'SQL\n'],
                    'env': [
                        {'name': 'PGCONNECT_TIMEOUT', 'value': '15'},
                        {'name': 'PGOPTIONS', 'value': '-c statement_timeout=120000'},
                        {'name': 'PGPASSWORD', 'valueFrom': {'secretKeyRef': {
                            'name': 'postgres-cluster-superuser', 'key': 'password',
                        }}},
                    ],
                    'resources': {'requests': {'cpu': '100m', 'memory': '64Mi'},
                                  'limits': {'memory': '128Mi'}},
                }],
            }},
        },
    }


def kubectl(*args, **kwargs):
    return subprocess.run(['kubectl', '--namespace=postgres', '--request-timeout=20s', *args],
                          text=True, check=True, **kwargs)


def wait_for_job(name, timeout=300):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = json.loads(kubectl('get', 'job', name, '-o', 'json', capture_output=True).stdout)
        conditions = job.get('status', {}).get('conditions', [])
        for condition in conditions:
            if condition.get('status') != 'True':
                continue
            if condition['type'] == 'Failed':
                raise RuntimeError('Database initialization failed: ' + condition.get('message', 'Job failed'))
            if condition['type'] == 'Complete':
                return
        time.sleep(2)
    raise TimeoutError('Database initialization did not complete within 300 seconds')


def main():
    name = 'opsiforce-db-init-' + uuid.uuid4().hex[:12]
    try:
        kubectl('create', '-f', '-', input=json.dumps(manifest(name)))
        wait_for_job(name)
        print('Opsiforce and Bifrost databases are ready.')
    finally:
        # Logs are diagnostic only; they never decide whether a database exists.
        for args in [('logs', 'job/' + name, '--all-containers=true'),
                     ('get', 'pods', '-l', 'job-name=' + name, '-o', 'wide'),
                     ('delete', 'job', name, '--ignore-not-found', '--wait=false')]:
            try:
                kubectl(*args)
            except subprocess.CalledProcessError:
                pass  # Preserve the initialization error; TTL provides backup cleanup.


if __name__ == '__main__':
    main()
