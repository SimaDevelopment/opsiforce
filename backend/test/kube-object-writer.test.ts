import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KubeObjectWriter } from '../src/common/kube-object-writer';

const kube = vi.hoisted(() => ({
  createNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
  replaceNamespacedCustomObject: vi.fn(),
  listNamespacedCustomObject: vi.fn(),
  deleteNamespacedCustomObject: vi.fn(),
  deleteNamespacedSecret: vi.fn(),
}));
vi.mock('../src/common/k8s-client', () => ({ loadKubeConfig: () => ({ makeApiClient: () => kube }) }));

const CERTIFICATES = { group: 'cert-manager.io', version: 'v1', plural: 'certificates' };
const DOMAIN_LABELS = { 'opsiforce.io/custom-domain': 'domain-1', 'opsiforce.io/environment': 'environment-1' };

function certificate(name: string) {
  return {
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: { name, namespace: 'opsiforce', labels: DOMAIN_LABELS },
    spec: { secretName: `${name}-tls`, dnsNames: ['shop.example-org.com'] },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('deleting objects by label', () => {
  it('deletes every object of the kind that carries all the labels', async () => {
    kube.listNamespacedCustomObject.mockResolvedValue({
      items: [certificate('opsiforce-domain-1'), certificate('opsiforce-domain-1-old')],
    });

    await new KubeObjectWriter('opsiforce').deleteByLabels(CERTIFICATES, DOMAIN_LABELS);

    expect(kube.listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: 'opsiforce',
      plural: 'certificates',
      labelSelector: 'opsiforce.io/custom-domain=domain-1,opsiforce.io/environment=environment-1',
    });
    expect(kube.deleteNamespacedCustomObject.mock.calls.map(([request]) => request)).toEqual([
      {
        group: 'cert-manager.io',
        version: 'v1',
        namespace: 'opsiforce',
        plural: 'certificates',
        name: 'opsiforce-domain-1',
      },
      {
        group: 'cert-manager.io',
        version: 'v1',
        namespace: 'opsiforce',
        plural: 'certificates',
        name: 'opsiforce-domain-1-old',
      },
    ]);
  });
});

describe('deleting a Secret', () => {
  it('deletes the named Secret in the namespace', async () => {
    await new KubeObjectWriter('opsiforce').deleteSecretIfExists('opsiforce-domain-1-tls');

    expect(kube.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: 'opsiforce-domain-1-tls',
      namespace: 'opsiforce',
    });
  });

  it('treats a Secret that is already gone as deleted', async () => {
    kube.deleteNamespacedSecret.mockRejectedValue({ code: 404 });

    await expect(
      new KubeObjectWriter('opsiforce').deleteSecretIfExists('opsiforce-domain-1-tls')
    ).resolves.toBeUndefined();
  });

  it('passes on any other failure', async () => {
    kube.deleteNamespacedSecret.mockRejectedValue({ code: 403 });

    await expect(new KubeObjectWriter('opsiforce').deleteSecretIfExists('opsiforce-domain-1-tls')).rejects.toEqual({
      code: 403,
    });
  });
});

describe('writing an object of any kind', () => {
  it('creates the object in the namespace', async () => {
    await new KubeObjectWriter('opsiforce').upsert(
      CERTIFICATES,
      'opsiforce-domain-1',
      certificate('opsiforce-domain-1')
    );

    expect(kube.createNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: 'opsiforce',
      plural: 'certificates',
      body: certificate('opsiforce-domain-1'),
    });
    expect(kube.replaceNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('replaces an object that already exists, at its current version', async () => {
    kube.createNamespacedCustomObject.mockRejectedValue({ code: 409 });
    kube.getNamespacedCustomObject.mockResolvedValue({
      ...certificate('opsiforce-domain-1'),
      metadata: { ...certificate('opsiforce-domain-1').metadata, resourceVersion: '42' },
    });

    await new KubeObjectWriter('opsiforce').upsert(
      CERTIFICATES,
      'opsiforce-domain-1',
      certificate('opsiforce-domain-1')
    );

    expect(kube.replaceNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: 'opsiforce',
      plural: 'certificates',
      name: 'opsiforce-domain-1',
      body: {
        ...certificate('opsiforce-domain-1'),
        metadata: { ...certificate('opsiforce-domain-1').metadata, resourceVersion: '42' },
      },
    });
  });
});

describe('finding an object of any kind', () => {
  it('returns the object', async () => {
    kube.getNamespacedCustomObject.mockResolvedValue(certificate('opsiforce-domain-1'));

    await expect(new KubeObjectWriter('opsiforce').find(CERTIFICATES, 'opsiforce-domain-1')).resolves.toEqual(
      certificate('opsiforce-domain-1')
    );
    expect(kube.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: 'opsiforce',
      plural: 'certificates',
      name: 'opsiforce-domain-1',
    });
  });

  it('returns nothing for an object that does not exist', async () => {
    kube.getNamespacedCustomObject.mockRejectedValue({ code: 404 });

    await expect(new KubeObjectWriter('opsiforce').find(CERTIFICATES, 'opsiforce-domain-1')).resolves.toBeUndefined();
  });
});
