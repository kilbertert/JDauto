import { contextBridge, ipcRenderer } from 'electron';
import type { JDAutoDesktopBridge } from './ipc-contract.cjs';

const api: JDAutoDesktopBridge = {
  getState: () => ipcRenderer.invoke('jdauto:get-state'),
  start: (payload) => ipcRenderer.invoke('jdauto:start', payload),
  stop: () => ipcRenderer.invoke('jdauto:stop'),
  syncProfiles: () => ipcRenderer.invoke('jdauto:sync-profiles'),
  cleanupProfiles: () => ipcRenderer.invoke('jdauto:cleanup-opencli-profiles'),
  initProfiles: (payload) => ipcRenderer.invoke('jdauto:init-profiles', payload),
};

contextBridge.exposeInMainWorld('jdauto', api);
