import { useDraggable } from '@dnd-kit/solid';
import { type Project } from '~/api/client';
import { DndType, type ProjectDragData } from '~/lib/sidebar-dnd';
import { ProjectCard } from '../project-card';

export function SidebarDraggableProjectRow(props: {
  project: Project;
  isActive: boolean;
  onSelect: () => void;
  onRename: (id: string, title: string) => void;
  onSettings: () => void;
  onDeleted: () => void;
}) {
  const draggable = useDraggable({
    get id() {
      return `proj:${props.project.id}`;
    },
    type: DndType.Project,
    get data(): ProjectDragData {
      return { projectId: props.project.id };
    },
  });

  return (
    <div ref={draggable.ref} style={{ opacity: draggable.isDragging() ? 0.5 : 1 }}>
      <ProjectCard
        project={props.project}
        isActive={props.isActive}
        onSelect={props.onSelect}
        onRename={props.onRename}
        onSettings={props.onSettings}
        onDeleted={props.onDeleted}
      />
    </div>
  );
}
