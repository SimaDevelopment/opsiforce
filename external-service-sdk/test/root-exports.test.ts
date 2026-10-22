import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const packageRoot = dirname(fileURLToPath(import.meta.resolve('@opsiforce/external-service-sdk/package.json')));

const authorFacingRootExports = [
  'AnyServiceTypes',
  'AtomicServiceState',
  'Awaitable',
  'ButtonResult',
  'CallOutcome',
  'CallerIdentity',
  'CallerKind',
  'ConfigurationChange',
  'ConfigurationHooks',
  'Configurations',
  'CounterDeclaration',
  'DefinedService',
  'DeliveredEvent',
  'DeliveredEventFile',
  'DeliveryResult',
  'DeliveryResultKind',
  'Field',
  'FieldType',
  'Form',
  'FormDraft',
  'FormHandlerContext',
  'FormName',
  'FormValues',
  'Forward',
  'InfoResult',
  'ManifestCheck',
  'ManifestProblem',
  'MessageLevel',
  'OptionItem',
  'OptionsDraft',
  'OptionsSource',
  'OutgoingRequest',
  'ProjectConfigurationEntry',
  'Refusal',
  'RefusalOutcome',
  'Route',
  'RouteAction',
  'RouteCheck',
  'RouteContext',
  'RouteHandler',
  'RouteOptions',
  'RouteThrough',
  'Secret',
  'ServiceDefinition',
  'ServiceDefinitionError',
  'ServiceEvent',
  'ServiceHandle',
  'ServiceManifest',
  'ServiceState',
  'ServiceTypes',
  'StateEntry',
  'Upstream',
  'UpstreamCredentials',
  'UpstreamOptions',
  'Verdict',
  'VisibleWhen',
  'WebhookContext',
  'WebhookHandler',
  'allowAll',
  'checkServiceManifest',
  'defineService',
  'outcomeHeader',
  'refusalStatuses',
  'route',
  'sdkVersion',
  'settingHeader',
  'upstream',
];

function exportedNames(entry: string): string[] {
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`cannot read the exports of ${entry}`);
  return checker
    .getExportsOfModule(module)
    .map((symbol) => symbol.name)
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

test('the root entry point exports only the author-facing surface; platform and form helpers live in ./platform and ./forms', () => {
  assert.deepEqual(exportedNames(join(packageRoot, 'src', 'index.ts')), authorFacingRootExports);
});
