import { createAppQuery } from '~/lib/create-app-query';

export interface DesktopWindow {
  id: string;
  title: string;
  pid: number;
}

export interface DesktopSession {
  id: string;
  title: string;
  display: string;
  windows: DesktopWindow[];
  visible: boolean;
  preferredWindow: string;
  presentation: number;
}

export function desktopBase(environmentId: string) {
  return `/api/proxy/${encodeURIComponent(environmentId)}/_desktop`;
}

export function useDesktops(environmentId: () => string, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: ['desktops', environmentId()],
    enabled: enabled(),
    queryFn: async (): Promise<DesktopSession[]> => {
      const response = await fetch(`${desktopBase(environmentId())}/sessions`);
      if (!response.ok) throw new Error('Desktop sessions are unavailable. The agent may need an image update.');
      return response.json();
    },
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: false,
  }));
}
