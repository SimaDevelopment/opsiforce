export interface ProjectCreatedRow {
  builderChatId: string | null;
  createdByProjectId: string | null;
}

export function isWithinCallingProject(row: ProjectCreatedRow, callingProjectId: string | undefined): boolean {
  if (callingProjectId === undefined) return true;
  return row.builderChatId === callingProjectId || row.createdByProjectId === callingProjectId;
}
