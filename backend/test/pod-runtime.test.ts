import { describe, expect, it } from 'vitest';
import { buildPodSpec, type PodTemplateOptions } from '../src/pod/pod.template';

const options: PodTemplateOptions = {
  podName: 'app-test',
  namespace: 'opsiforce',
  agentContainerImage: 'agent:test',
  agentPort: 4096,
  storageType: 'cephfs',
  cephfsPvcName: 'opsiforce-cephfs',
  storageMountPath: '/workspace-data',
  subPath: 'projects/example',
  imagePullPolicy: 'IfNotPresent',
  resources: { requests: { cpu: '500m', memory: '2Gi' }, limits: { memory: '4Gi' } },
  nodeSelector: { 'topology.kubernetes.io/region': 'hel1' },
};

describe('generated app runtime', () => {
  it('selects Kata while preserving placement and workspace mounts', () => {
    const pod = buildPodSpec({ ...options, runtimeClassName: 'kata-clh-runtime-rs-opsiforce' });
    expect(pod.spec?.runtimeClassName).toBe('kata-clh-runtime-rs-opsiforce');
    expect(pod.spec?.nodeSelector).toEqual(options.nodeSelector);
    expect(pod.spec?.volumes?.[0].persistentVolumeClaim?.claimName).toBe('opsiforce-cephfs');
    expect(pod.spec?.initContainers?.[0].volumeMounts?.[0].subPath).toBe(options.subPath);
    expect(pod.spec?.containers[0].volumeMounts?.[0].subPath).toBe(options.subPath);
  });

  it.each([undefined, ''])('uses the default runtime when configured as %s', (runtimeClassName) => {
    expect(buildPodSpec({ ...options, runtimeClassName }).spec).not.toHaveProperty('runtimeClassName');
  });
});

describe('privileged Kata agents', () => {
  it('enables privileged mode for both the app and init containers', () => {
    const pod = buildPodSpec({ ...options, runtimeClassName: 'kata-clh-runtime-rs-opsiforce', privileged: true });
    expect(pod.spec?.containers[0].securityContext).toEqual({ privileged: true });
    expect(pod.spec?.initContainers?.[0].securityContext).toEqual({ privileged: true });
    expect(pod.spec?.volumes?.[0].persistentVolumeClaim?.claimName).toBe('opsiforce-cephfs');
  });

  it.each([undefined, '', 'kata-clh-runtime-rs-opsiforce'])('keeps privilege off by default for runtime %s', (runtimeClassName) => {
    const pod = buildPodSpec({ ...options, runtimeClassName });
    expect(pod.spec?.containers[0].securityContext).toBeUndefined();
    expect(pod.spec?.initContainers?.[0].securityContext).toBeUndefined();
  });

  it.each([undefined, '', 'runc', 'unrecognized-runtime'])('rejects privilege outside Kata: %s', (runtimeClassName) => {
    expect(() => buildPodSpec({ ...options, runtimeClassName, privileged: true })).toThrow('Privileged agents require');
  });
});
