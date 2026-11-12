'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  getConfig: call('config:get'),
  setConfig: call('config:set'),
  envInfo: call('env:info'),
  searchMovies: call('movie:search'),
  movieDetails: call('movie:details'),
  findTrailers: call('trailer:find'),
  searchTrailers: call('trailer:search'),
  downloadTrailer: call('trailer:download'),
  updateTool: call('trailer:updateTool'),
  pickFile: call('dialog:pick'),
  updateCheck: call('update:check'),
  updateDownload: call('update:download'),
  updateRestart: call('update:restart'),
  openExternal: call('open:external'),
  startShow: call('show:start'),
  showData: call('show:data'),
  closeShow: call('show:close'),
  finishShow: call('show:finish'),
  prepareOtt: call('show:prepareOtt'),
  reportStatus: (st) => ipcRenderer.send('show:status', st),
  remoteCommand: call('remote:cmd'),
  on: (channel, fn) => {
    if (!['trailer:progress', 'show:closed', 'show:status', 'remote:cmd', 'update:progress'].includes(channel)) return;
    ipcRenderer.on(channel, (e, data) => fn(data));
  },
});
