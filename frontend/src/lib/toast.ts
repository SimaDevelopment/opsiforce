import { toast as sonner } from 'solid-sonner';

export const PLATFORM_TOASTER_ID = 'platform';

type ToastContent = Parameters<typeof sonner.success>[0];
type ToastOptions = NonNullable<Parameters<typeof sonner.success>[1]>;

const platformToast =
  (show: (message: ToastContent, data?: ToastOptions) => string | number) =>
  (message: ToastContent, data?: ToastOptions) =>
    show(message, { ...data, toasterId: PLATFORM_TOASTER_ID });

export const toast = Object.assign(platformToast(sonner), {
  success: platformToast(sonner.success),
  info: platformToast(sonner.info),
  warning: platformToast(sonner.warning),
  error: platformToast(sonner.error),
  loading: platformToast(sonner.loading),
  message: platformToast(sonner.message),
  dismiss: sonner.dismiss,
});
