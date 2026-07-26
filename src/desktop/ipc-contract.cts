export const DESKTOP_IPC_CHANNELS = {
  getState: 'jdauto:get-state',
  start: 'jdauto:start',
  stop: 'jdauto:stop',
  syncProfiles: 'jdauto:sync-profiles',
  cleanupProfiles: 'jdauto:cleanup-opencli-profiles',
  initProfiles: 'jdauto:init-profiles',
} as const;

export interface StartRequestBody {
  sku?: string;
  time?: string;
  password?: string;
  maxRetries?: number;
  prepareAhead?: number;
  accounts?: number;
  manual?: boolean;
}

export interface InitProfilesPayload {
  count?: number;
}

export interface RunState {
  running: boolean;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  command?: string;
  logs: string[];
}

export interface DesktopState extends RunState {
  configPreview: {
    accountCount: number;
    accountNames: string[];
  };
}

export interface JDAutoDesktopBridge {
  getState: () => Promise<DesktopState>;
  start: (payload: StartRequestBody) => Promise<DesktopState>;
  stop: () => Promise<DesktopState>;
  syncProfiles: () => Promise<DesktopState>;
  cleanupProfiles: () => Promise<DesktopState>;
  initProfiles: (payload: InitProfilesPayload) => Promise<DesktopState>;
}
