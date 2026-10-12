import type { db } from '../../../db';

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
