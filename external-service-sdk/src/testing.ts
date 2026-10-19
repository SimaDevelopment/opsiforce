import type { DefinedService, ServiceTypes } from './define-service.ts';
import { testDefinedService, type ServiceTestKit, type ServiceTestOptions } from './service-testing.ts';

export {
  staticConfigurations,
  testGatewayKey,
  testServiceCaller,
  testServiceHost,
  testServiceWebhookUrl,
  testSettingsBase,
  type ServiceTestKit,
  type ServiceTestOptions,
  type StaticConfigurationOptions,
  type TestDelivery,
  type UpstreamFake,
} from './service-testing.ts';

export function testService<Types extends ServiceTypes>(
  service: DefinedService<Types>,
  options?: ServiceTestOptions
): ServiceTestKit {
  return testDefinedService(service as unknown as DefinedService, options);
}
