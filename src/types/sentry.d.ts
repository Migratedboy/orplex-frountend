// Type declaration for optional @sentry/nextjs dependency
// This module is only needed if BUGSINK_DSN is configured
declare module "@sentry/nextjs" {
  export function init(options: Record<string, unknown>): void;
  export function captureException(error: Error): string;
  export function captureMessage(message: string, level?: string): string;
  export function withScope(callback: (scope: any) => void): void;
}
