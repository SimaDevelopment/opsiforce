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

  it.each([undefined, '', 'kata-clh-runtime-rs-opsiforce'])(
    'keeps privilege off by default for runtime %s',
    (runtimeClassName) => {
      const pod = buildPodSpec({ ...options, runtimeClassName });
      expect(pod.spec?.containers[0].securityContext).toBeUndefined();
      expect(pod.spec?.initContainers?.[0].securityContext).toBeUndefined();
    }
  );

  it.each([undefined, '', 'runc', 'unrecognized-runtime'])('rejects privilege outside Kata: %s', (runtimeClassName) => {
    expect(() => buildPodSpec({ ...options, runtimeClassName, privileged: true })).toThrow('Privileged agents require');
  });
});

describe('small class CPU reservation', () => {
  it('requests 100m without capping CPU or changing memory', () => {
    expect(buildPodSpec(options).spec?.containers[0].resources).toEqual({
      requests: { cpu: '100m', memory: '2048Mi' },
      limits: { memory: '4096Mi' },
    });
  });

  it('uses the new preset when recreating a project with saved 500m settings', () => {
    expect(
      resolveStoredPodResources({ podClass: 'small', cpuMillicores: 500, memoryRequestMib: 2048, memoryLimitMib: 4096 })
    ).toEqual(resolvePreset('small'));
  });

  it('preserves custom settings and the larger class reservations', () => {
    const custom = { podClass: 'custom' as const, cpuMillicores: 500, memoryRequestMib: 2048, memoryLimitMib: 4096 };
    expect(resolveStoredPodResources(custom)).toEqual(custom);
    expect(resolvePreset('medium').cpuMillicores).toBe(1000);
    expect(resolvePreset('large').cpuMillicores).toBe(2000);
    expect(resolveStoredPodResources()).toEqual(resolvePreset('small'));
  });
});

describe('reaching External Services from a pod', () => {
  const calling = { ...options, gatewayApiKey: 'gw-pod-key', gatewayUrl: 'http://backend/api/gateway' };
  const envOf = (pod: ReturnType<typeof buildPodSpec>) =>
    Object.fromEntries((pod.spec?.containers[0].env ?? []).map((variable) => [variable.name, variable.value]));

  it('names the Service host family and no old Gate mount', () => {
    const env = envOf(buildPodSpec({ ...calling, externalServicesHost: 'external-services.opsiforce.example.com' }));

    expect(env.EXTERNAL_SERVICES_HOST).toBe('external-services.opsiforce.example.com');
    expect(env).not.toHaveProperty('EXTERNAL_SERVICES_URL');
  });

  it("tells a service copy's pod its Webhook address", () => {
    const address = 'https://opsiforce.example.com/api/external-services/webhooks/service-1/development';

    expect(envOf(buildPodSpec({ ...calling, serviceWebhookUrl: address })).SERVICE_WEBHOOK_URL).toBe(address);
    expect(envOf(buildPodSpec(calling))).not.toHaveProperty('SERVICE_WEBHOOK_URL');
  });

  it('trusts an extra CA bundle in every TLS client when one is configured', () => {
    const pod = buildPodSpec({ ...calling, caBundleConfigMap: 'opsiforce-local-ca' });
    const env = envOf(pod);
    const bundle = '/etc/opsiforce/ca/ca-certificates.crt';

    for (const name of [
      'SSL_CERT_FILE',
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
      'NODE_EXTRA_CA_CERTS',
      'REQUESTS_CA_BUNDLE',
    ]) {
      expect(env[name], name).toBe(bundle);
    }
    expect(pod.spec?.containers[0].volumeMounts).toContainEqual({
      name: 'ca-bundle',
      mountPath: '/etc/opsiforce/ca',
      readOnly: true,
    });
    expect(pod.spec?.volumes).toContainEqual({ name: 'ca-bundle', configMap: { name: 'opsiforce-local-ca' } });
  });

  it('leaves the image trust store alone otherwise', () => {
    const pod = buildPodSpec(calling);

    expect(envOf(pod).SSL_CERT_FILE).toBeUndefined();
    expect(pod.spec?.volumes?.map((volume) => volume.name)).toEqual(['workspace']);
  });
});
