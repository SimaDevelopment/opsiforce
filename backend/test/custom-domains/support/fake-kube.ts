type Labels = Record<string, string>;

export interface FakeKubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: { name: string; resourceVersion?: string; labels?: Labels };
  spec: Record<string, unknown> & { secretName?: string; dnsNames?: string[] };
  status?: Record<string, unknown>;
}

interface KindRequest {
  plural: string;
}

type NamedRequest = KindRequest & { name: string };
type BodyRequest = KindRequest & { body: FakeKubeObject };

const notFound = () => Object.assign(new Error('Not Found'), { code: 404 });
const conflict = () => Object.assign(new Error('Conflict'), { code: 409 });
const unavailable = () => Object.assign(new Error('Service Unavailable'), { code: 503 });

type Action = 'create' | 'replace' | 'delete';

function selected(object: FakeKubeObject, selector: string | undefined): boolean {
  if (!selector) return true;
  return selector.split(',').every((pair) => {
    const [key, value] = pair.split('=');
    return object.metadata.labels?.[key] === value;
  });
}

export class FakeKube {
  private readonly objects = new Map<string, FakeKubeObject>();
  private readonly secretNames = new Set<string>();
  private readonly log: string[] = [];
  private readonly failures: string[] = [];
  private version = 0;

  async createNamespacedCustomObject({ plural, body }: BodyRequest): Promise<FakeKubeObject> {
    this.failIfAsked('create', plural);
    const object = structuredClone(body);
    if (this.objects.has(this.key(plural, object.metadata.name))) throw conflict();
    this.store(plural, object);
    this.log.push(`create ${plural}/${object.metadata.name}`);
    return object;
  }

  async replaceNamespacedCustomObject({ plural, name, body }: NamedRequest & BodyRequest): Promise<FakeKubeObject> {
    this.failIfAsked('replace', plural);
    const existing = this.objects.get(this.key(plural, name));
    if (!existing) throw notFound();
    if (body.metadata.resourceVersion !== existing.metadata.resourceVersion) throw conflict();
    const object = { ...structuredClone(body), status: existing.status };
    this.store(plural, object);
    this.log.push(`replace ${plural}/${name}`);
    return object;
  }

  async getNamespacedCustomObject({ plural, name }: NamedRequest): Promise<FakeKubeObject> {
    const object = this.objects.get(this.key(plural, name));
    if (!object) throw notFound();
    return structuredClone(object);
  }

  async listNamespacedCustomObject({
    plural,
    labelSelector,
  }: KindRequest & { labelSelector?: string }): Promise<{ items: FakeKubeObject[] }> {
    return { items: this.all(plural).filter((object) => selected(object, labelSelector)) };
  }

  async deleteNamespacedCustomObject({ plural, name }: NamedRequest): Promise<void> {
    this.failIfAsked('delete', plural);
    if (!this.objects.delete(this.key(plural, name))) throw notFound();
    this.log.push(`delete ${plural}/${name}`);
  }

  async deleteNamespacedSecret({ name }: { name: string }): Promise<void> {
    if (!this.secretNames.delete(name)) throw notFound();
    this.log.push(`delete secrets/${name}`);
  }

  failNext(action: Action, plural: string): void {
    this.failures.push(`${action} ${plural}`);
  }

  private failIfAsked(action: Action, plural: string): void {
    const at = this.failures.indexOf(`${action} ${plural}`);
    if (at === -1) return;
    this.failures.splice(at, 1);
    throw unavailable();
  }

  object(plural: string, name: string): FakeKubeObject | undefined {
    const object = this.objects.get(this.key(plural, name));
    return object && structuredClone(object);
  }

  labelled(plural: string, labels: Labels): FakeKubeObject[] {
    return this.all(plural).filter((object) =>
      Object.entries(labels).every(([key, value]) => object.metadata.labels?.[key] === value)
    );
  }

  hasSecret(name: string): boolean {
    return this.secretNames.has(name);
  }

  actionsOn(plural: string, name: string): string[] {
    return this.log.filter((entry) => entry.endsWith(` ${plural}/${name}`)).map((entry) => entry.split(' ')[0]);
  }

  issue(certificateName: string): void {
    const certificate = this.certificate(certificateName);
    certificate.status = {
      conditions: [
        { type: 'Ready', status: 'True', reason: 'Ready', message: 'Certificate is up to date and has not expired' },
      ],
    };
    if (certificate.spec.secretName) this.secretNames.add(certificate.spec.secretName);
  }

  failIssuing(certificateName: string, message: string): void {
    this.certificate(certificateName).status = {
      conditions: [
        {
          type: 'Ready',
          status: 'False',
          reason: 'DoesNotExist',
          message: 'Issuing certificate as Secret does not exist',
        },
        { type: 'Issuing', status: 'False', reason: 'Failed', message },
      ],
      failedIssuanceAttempts: 1,
      lastFailureTime: new Date().toISOString(),
    };
  }

  startIssuing(certificateName: string): void {
    this.certificate(certificateName).status = {
      conditions: [
        {
          type: 'Ready',
          status: 'False',
          reason: 'DoesNotExist',
          message: 'Issuing certificate as Secret does not exist',
        },
        {
          type: 'Issuing',
          status: 'True',
          reason: 'DoesNotExist',
          message: 'Issuing certificate as Secret does not exist',
        },
      ],
    };
  }

  private certificate(name: string): FakeKubeObject {
    const certificate = this.objects.get(this.key('certificates', name));
    if (!certificate) throw new Error(`No Certificate ${name}`);
    return certificate;
  }

  private all(plural: string): FakeKubeObject[] {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${plural}/`))
      .map(([, object]) => structuredClone(object));
  }

  private store(plural: string, object: FakeKubeObject): void {
    object.metadata.resourceVersion = String(++this.version);
    this.objects.set(this.key(plural, object.metadata.name), object);
  }

  private key(plural: string, name: string): string {
    return `${plural}/${name}`;
  }
}

export const fakeKube = new FakeKube();
