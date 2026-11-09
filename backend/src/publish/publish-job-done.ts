import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { projectPublishJobs } from '../../db/schema';
import { PublishStatus } from './publish.types';

export async function publishJobDone(publishJobId: string): Promise<boolean> {
  const [job] = await db
    .select({ status: projectPublishJobs.status })
    .from(projectPublishJobs)
    .where(eq(projectPublishJobs.id, publishJobId));
  return job?.status === PublishStatus.Done;
}
