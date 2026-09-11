import { Injectable } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import { db } from '../../../db';
import { agents } from '../../../db/schema';
import { beforeCursor, cursorValue, takePage, type CursorPageQuery, type TakenPage } from '../pagination';

export interface AgentRow {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  cursorAt: string;
}

@Injectable()
export class PublicAgentsRepository {
  async page(query: CursorPageQuery): Promise<TakenPage<AgentRow>> {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        description: agents.description,
        cursorAt: cursorValue(agents.createdAt),
      })
      .from(agents)
      .where(beforeCursor(agents.createdAt, agents.id, query.cursor))
      .orderBy(desc(agents.createdAt), desc(agents.id))
      .limit(query.limit + 1);

    return takePage(rows, query.limit);
  }
}
