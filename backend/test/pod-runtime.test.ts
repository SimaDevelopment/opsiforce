import { describe, expect, it } from 'vitest';
import { buildPodSpec, type PodTemplateOptions } from '../src/pod/pod.template';
import { JOB_POD_RESOURCES, resourceBoundsFrom, toK8sResources } from '../src/pod/pod-classes';
import { podSettingsOn, type PresetCatalog } from '../src/pod/resource-presets';

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
  resources: toK8sResources(JOB_POD_RESOURCES),
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

describe('agent readiness', () => {
  it('is ready once opencode answers /api/info through the agent port, with no liveness probe', () => {
    const [agent] = buildPodSpec(options).spec?.containers ?? [];
    expect(agent.readinessProbe).toEqual({
      httpGet: { path: '/api/info', port: 4096 },
      initialDelaySeconds: 5,
      periodSeconds: 10,
      timeoutSeconds: 10,
      failureThreshold: 12,
    });
    expect(agent.livenessProbe).toBeUndefined();
  });
});

describe('agent pod credentials', () => {
  it('mounts no Kubernetes API token, since nothing in the pod calls the API', () => {
    expect(buildPodSpec(options).spec?.automountServiceAccountToken).toBe(false);
  });
});

describe('desktop shared memory', () => {
  it.each([undefined, 'kata-clh-runtime-rs-opsiforce'])(
    'provides private bounded shared memory without increasing agent memory for runtime %s',
    (runtimeClassName) => {
      const pod = buildPodSpec({ ...options, runtimeClassName, caBundleConfigMap: 'local-ca' });
      const agent = pod.spec!.containers[0];
      const mount = agent.volumeMounts?.find((volume) => volume.mountPath === '/dev/shm');
      expect(mount).toBeDefined();
      expect(mount?.readOnly).not.toBe(true);
      expect(pod.spec?.volumes?.find((volume) => volume.name === mount?.name)).toEqual({
        name: mount!.name,
        emptyDir: { medium: 'Memory', sizeLimit: '512Mi' },
      });
      expect(pod.spec?.hostIPC).not.toBe(true);
      expect(agent.resources).toEqual(options.resources);
      expect(agent.volumeMounts?.some((volume) => volume.mountPath === '/etc/opsiforce/ca')).toBe(true);
    }
  );
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

const envNames = (container?: { env?: Array<{ name: string }> }) => (container?.env ?? []).map(({ name }) => name);

describe('Docker in privileged Kata agents', () => {
  const kata = { ...options, runtimeClassName: 'kata-clh-runtime-rs-opsiforce' };

  it('turns Docker on in the agent container and gives it pod-local storage', () => {
    const pod = buildPodSpec({ ...kata, privileged: true });
    const [agent] = pod.spec?.containers ?? [];

    expect(agent.env).toContainEqual({ name: 'OPSIFORCE_DOCKER', value: '1' });
    expect(agent.volumeMounts).toContainEqual({ name: 'docker-storage', mountPath: '/var/lib/docker-storage' });
    expect(pod.spec?.volumes).toContainEqual({ name: 'docker-storage', emptyDir: { sizeLimit: '21Gi' } });
  });

  it('tells the init container which Skills this deployment does not offer', () => {
    const [init] = buildPodSpec({ ...options, unofferedSkills: ['docker'] }).spec?.initContainers ?? [];

    expect(init.env).toContainEqual({ name: 'SWITCHED_OFF_SKILLS', value: 'docker' });
  });

  it.each([undefined, []])(
    'leaves the init container without a skip list when every Skill is offered (%s)',
    (unofferedSkills) => {
      const [init] = buildPodSpec({ ...kata, privileged: true, unofferedSkills }).spec?.initContainers ?? [];

      expect(envNames(init)).not.toContain('SWITCHED_OFF_SKILLS');
    }
  );

  it('keeps Docker out of the init container', () => {
    const [init] = buildPodSpec({ ...kata, privileged: true }).spec?.initContainers ?? [];

    expect(envNames(init)).not.toContain('OPSIFORCE_DOCKER');
    expect(init.volumeMounts?.map(({ name }) => name)).toEqual(['workspace']);
  });

  it.each([undefined, '', 'kata-clh-runtime-rs-opsiforce'])(
    'leaves an unprivileged pod without Docker on runtime %s',
    (runtimeClassName) => {
      const pod = buildPodSpec({ ...options, runtimeClassName, caBundleConfigMap: 'opsiforce-local-ca' });
      const [agent] = pod.spec?.containers ?? [];

      expect(envNames(agent)).not.toContain('OPSIFORCE_DOCKER');
      expect(agent.volumeMounts?.map(({ name }) => name)).toEqual(['workspace', 'shared-memory', 'ca-bundle']);
      expect(pod.spec?.volumes?.map(({ name }) => name)).toEqual(['workspace', 'shared-memory', 'ca-bundle']);
    }
  );
});

describe('small class CPU reservation', () => {
  it('requests 100m without capping CPU or changing memory', () => {
    expect(buildPodSpec(options).spec?.containers[0].resources).toEqual({
      requests: { cpu: '100m', memory: '2048Mi' },
      limits: { memory: '4096Mi' },
    });
  });

  it("reads a stored choice at the Organization's current numbers, keeps Custom and falls back to the default", () => {
    const tiny = { cpuMillicores: 50, memoryRequestMib: 512, memoryLimitMib: 1024 };
    const catalog: PresetCatalog = {
      presets: [
        { id: 'tiny', name: 'Tiny', tenantId: null, resources: tiny, platformResources: tiny, overridden: false },
      ],
      defaultPresetId: 'tiny',
      platformDefaultPresetId: 'tiny',
      ownDefault: false,
    };
    const custom = {
      presetId: null,
      presetName: null,
      cpuMillicores: 500,
      memoryRequestMib: 2048,
      memoryLimitMib: 4096,
    };
    const onTiny = { presetId: 'tiny', presetName: 'Tiny', ...tiny };

    expect(podSettingsOn({ ...custom, presetId: 'tiny', presetName: 'Tiny' }, catalog)).toEqual(onTiny);
    expect(podSettingsOn(custom, catalog)).toEqual(custom);
    expect(podSettingsOn(undefined, catalog)).toEqual(onTiny);
    expect(podSettingsOn({ ...custom, presetId: 'deleted', presetName: null }, catalog)).toEqual(onTiny);
  });
});

describe('Resources maximum', () => {
  it("takes the cluster's maximum from its deployment and today's numbers otherwise", () => {
    expect(resourceBoundsFrom({}).max).toEqual({ cpuMillicores: 4000, memoryRequestMib: 16384, memoryLimitMib: 24576 });
    expect(
      resourceBoundsFrom({
        AGENT_MAX_CPU_MILLICORES: '7000',
        AGENT_MAX_MEMORY_REQUEST_MIB: '12288',
        AGENT_MAX_MEMORY_LIMIT_MIB: ' 16384 ',
      }).max
    ).toEqual({ cpuMillicores: 7000, memoryRequestMib: 12288, memoryLimitMib: 16384 });
  });

  it('refuses to start on a maximum no preset could meet', () => {
    expect(() => resourceBoundsFrom({ AGENT_MAX_CPU_MILLICORES: '4 vCPU' })).toThrow(/AGENT_MAX_CPU_MILLICORES/);
    expect(() => resourceBoundsFrom({ AGENT_MAX_MEMORY_REQUEST_MIB: '256' })).toThrow(/at least 512/);
    expect(() =>
      resourceBoundsFrom({ AGENT_MAX_MEMORY_REQUEST_MIB: '8192', AGENT_MAX_MEMORY_LIMIT_MIB: '4096' })
    ).toThrow(/AGENT_MAX_MEMORY_LIMIT_MIB/);
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

  it('lets agent-browser accept any certificate only when the deployment asks for it', () => {
    expect(envOf(buildPodSpec({ ...calling, browserIgnoresHttpsErrors: true })).AGENT_BROWSER_IGNORE_HTTPS_ERRORS).toBe(
      '1'
    );
    expect(envOf(buildPodSpec({ ...calling, caBundleConfigMap: 'opsiforce-local-ca' }))).not.toHaveProperty(
      'AGENT_BROWSER_IGNORE_HTTPS_ERRORS'
    );
  });

  it('leaves the image trust store alone otherwise', () => {
    const pod = buildPodSpec(calling);

    expect(envOf(pod).SSL_CERT_FILE).toBeUndefined();
    expect(pod.spec?.volumes?.some((volume) => volume.name === 'ca-bundle')).toBe(false);
  });
});
