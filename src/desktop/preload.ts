import { contextBridge, ipcRenderer } from 'electron';

interface StartPayload {
  sku?: string;
  time?: string;
  password?: string;
  maxRetries?: number;
  prepareAhead?: number;
  accounts?: number;
  manual?: boolean;
}

const api = {
  getState: () => ipcRenderer.invoke('jdauto:get-state'),
  start: (payload: StartPayload) => ipcRenderer.invoke('jdauto:start', payload),
  stop: () => ipcRenderer.invoke('jdauto:stop'),
};

contextBridge.exposeInMainWorld('jdauto', api);
