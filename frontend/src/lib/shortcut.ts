const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const modKeys = (key: string): string[] => (isApple ? ['⌘', key] : ['Ctrl', key]);

export const modShortcut = (key: string): string => (isApple ? `⌘${key}` : `Ctrl+${key}`);
