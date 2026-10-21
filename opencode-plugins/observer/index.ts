import type { Plugin } from '@opencode/plugin';

import { OBSERVER_ID, startObserver } from './observe.ts';

export default {
  id: OBSERVER_ID,
  setup: (ctx) =>
    startObserver({
      env: process.env,
      subscribe: (options) => ctx.event.subscribe(options),
      getSession: (sessionID) => ctx.session.get({ sessionID }),
    }),
} satisfies Plugin.Plugin;
