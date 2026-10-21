'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: async (ch, ...args) => {
    const r = await ipcRenderer.invoke(ch, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on: (ch, fn) => {
    const l = (_e, d) => fn(d);
    ipcRenderer.on(ch, l);
    return () => ipcRenderer.removeListener(ch, l);
  },
});
