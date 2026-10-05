import { describe, expect, it } from 'vitest';
import { buildPodSpec, type PodTemplateOptions } from '../src/pod/pod.template';
import { resolvePreset, resolveStoredPodResources, toK8sResources } from '../src/pod/pod-classes';

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
  resources: toK8sResources(resolvePreset('small')),
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

describe('small class CPU reservation', () => {
  it('requests 100m without capping CPU or changing memory', () => {
    expect(buildPodSpec(options).spec?.containers[0].resources).toEqual({
      requests: { cpu: '100m', memory: '2048Mi' }, limits: { memory: '4096Mi' },
    });
  });

  it('uses the new preset when recreating a project with saved 500m settings', () => {
    expect(resolveStoredPodResources({ podClass: 'small', cpuMillicores: 500,
      memoryRequestMib: 2048, memoryLimitMib: 4096 })).toEqual(resolvePreset('small'));
  });

  it('preserves custom settings and the larger class reservations', () => {
    const custom = { podClass: 'custom' as const, cpuMillicores: 500, memoryRequestMib: 2048, memoryLimitMib: 4096 };
    expect(resolveStoredPodResources(custom)).toEqual(custom);
    expect(resolvePreset('medium').cpuMillicores).toBe(1000);
    expect(resolvePreset('large').cpuMillicores).toBe(2000);
    expect(resolveStoredPodResources()).toEqual(resolvePreset('small'));
  });
});
