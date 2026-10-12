import { describe, expect, it } from 'vitest';
import type { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { DefaultLaneHolds } from '../../src/external-services/gate/default-lane-holds';
import {
  DefaultLaneMoved,
  ServiceDispatchError,
  ServiceDispatcher,
} from '../../src/external-services/gate/service-dispatcher';
import type { ServicePods } from '../../src/external-services/gate/service-pods';
import type { RegisteredService } from '../../src/external-services/registry/service-registry';

const onProductionDefault = {
  id: 'es_trel',
  slug: 'trello',
  home: {
    builderChatId: 'chat_trel',
    environmentId: 'env_production',
    projectEnvironmentId: 'pe_production',
    disabled: false,
    sdkVersion: null,
    lane: 'default',
  },
} as RegisteredService;

function dispatcherWith(holds: DefaultLaneHolds): ServiceDispatcher {
  return new ServiceDispatcher({} as ServicePods, {} as GatewayKeyService, holds);
}

function failureOf(dispatching: Promise<unknown>): Promise<unknown> {
  return dispatching.then(
    () => null,
    (error: unknown) => error
  );
}

describe('the holds on a Custom External Service’s Default lane', () => {
  it('turns away a call resolved to the old Default once a switch has moved it', async () => {
    const holds = new DefaultLaneHolds();
    expect(await holds.hold('es_trel', 1_000)).toBe(true);
    holds.release('es_trel', 'env_staging');

    expect(holds.enter('es_trel', 'env_production')).toBe('moved');
    expect(holds.enter('es_trel', 'env_staging')).toBe('entered');
  });

  it('keeps the Default when a switch gives up', async () => {
    const holds = new DefaultLaneHolds();
    expect(await holds.hold('es_trel', 1_000)).toBe(true);
    holds.release('es_trel');

    expect(holds.enter('es_trel', 'env_production')).toBe('entered');
  });

  it('lets a webhook wait out a short hold instead of turning it away', async () => {
    const holds = new DefaultLaneHolds();
    expect(await holds.hold('es_trel', 1_000)).toBe(true);

    const waiting = holds.enterWaiting('es_trel', 'env_production', 2_000);
    expect(holds.enter('es_trel', 'env_production')).toBe('held');
    setTimeout(() => holds.release('es_trel'), 50);

    expect(await waiting).toBe('entered');
  });

  it('turns a webhook away when the hold outlasts its wait', async () => {
    const holds = new DefaultLaneHolds();
    expect(await holds.hold('es_trel', 1_000)).toBe(true);

    expect(await holds.enterWaiting('es_trel', 'env_production', 20)).toBe('held');
  });

  it('waits for calls already running before a switch copies the state file', async () => {
    const holds = new DefaultLaneHolds();
    expect(holds.enter('es_trel', 'env_production')).toBe('entered');

    const draining = holds.hold('es_trel', 2_000);
    setTimeout(() => holds.leave('es_trel'), 50);

    expect(await draining).toBe(true);
  });
});

describe('a call the dispatcher turns away from a Custom External Service’s Default lane', () => {
  it('says the Default moved when a switch moved it away from the environment the call was routed to', async () => {
    const holds = new DefaultLaneHolds();
    expect(await holds.hold('es_trel', 1_000)).toBe(true);
    holds.release('es_trel', 'env_staging');

    const failure = await failureOf(
      dispatcherWith(holds).dispatch(onProductionDefault, { route: 'inbound', body: {} })
    );

    expect(failure).toBeInstanceOf(DefaultLaneMoved);
  });

  it('says only that the service is reloading when a hold outlasts a call that may not wait', async () => {
    const holds = new DefaultLaneHolds();
    expect(await holds.hold('es_trel', 1_000)).toBe(true);

    const failure = await failureOf(
      dispatcherWith(holds).dispatch(onProductionDefault, { route: 'operations', name: 'list', body: {} })
    );

    expect(failure).toBeInstanceOf(ServiceDispatchError);
    expect(failure).not.toBeInstanceOf(DefaultLaneMoved);
    expect(failure).toMatchObject({ code: 'service-reloading' });
  });
});
