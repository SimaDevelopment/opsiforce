import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService } from '../src/project/project.service';
import { ProjectStatus } from '../src/project/project.types';
import { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import { createObservationSeam, type ObservationSeam, type ObservedProject } from './support/observation-seam';

let seam: ObservationSeam;

beforeAll(async () => {
  seam = await createObservationSeam();
});

afterAll(async () => {
  await seam?.close();
});

beforeEach(() => seam.reset());

const projects = () => seam.app.get(ProjectService);
const environments = () => seam.app.get(ProjectEnvironmentService);
const disable = (project: ObservedProject) => projects().disable(project.projectId, project.tenant.tenantId);

describe('disabling a Project', () => {
  it('suspends an environment that has a pod', async () => {
    const project = await seam.createRunningProject();

    await disable(project);

    expect((await environments().findById(project.environmentId)).status).toBe(ProjectStatus.Suspended);
  });

  it('leaves an environment mid-Publish to its Publish, which still records the deployed commit', async () => {
    const project = await seam.createRunningProject();
    await environments().patch(project.environmentId, { status: ProjectStatus.Publishing });

    await disable(project);
    await projects().finishPublishDeploy(project.environmentId, 'abc1234');

    expect(await environments().findById(project.environmentId)).toMatchObject({
      status: ProjectStatus.Active,
      deployedCommitSha: 'abc1234',
      disabled: true,
    });
  });
});
