/**
 * Sonic 1 WASM Save Manager
 * Persists game progress using Emscripten FS API + IndexedDB/localStorage
 * Supports auto-save, export (download), and import (upload)
 */
(function(global) {
  'use strict';

  const STORAGE_KEY = 'sonic1_wasm_save';
  const IDB_NAME = 'sonic1_wasm_saves';
  const IDB_STORE = 'savedata';
  const IDB_VERSION = 2; // Bumped to force schema upgrade for existing DBs
  const SKIP_PATHS = ['/Data.rsdk']; // Skip preloaded game data (38MB)

  function getIndexedDB() {
    return global.indexedDB || global.mozIndexedDB || global.webkitIndexedDB || global.msIndexedDB;
  }

  function collectSaveFiles(FS) {
    const files = {};
    function walk(node, path) {
      path = path || '/';
      try {
        const entries = FS.readdir(path);
        for (const name of entries) {
          if (name === '.' || name === '..') continue;
          const fullPath = path === '/' ? '/' + name : path + '/' + name;
          if (SKIP_PATHS.some(p => fullPath === p || fullPath.startsWith(p + '/'))) continue;
          try {
            const stat = FS.stat(fullPath);
            if (FS.isDir(stat.mode)) {
              walk(null, fullPath);
            } else {
              const stream = FS.open(fullPath, 'r');
              const data = FS.read(stream, stat.size, 0);
              FS.close(stream);
              files[fullPath] = Array.from(data);
            }
          } catch (e) {
            // Skip inaccessible entries
          }
        }
      } catch (e) {
        console.warn('[SaveManager] Could not read path:', path, e);
      }
    }
    walk(FS.root, '/');
    return files;
  }

  function restoreSaveFiles(FS, files) {
    for (const path in files) {
      try {
        const dir = path.substring(0, path.lastIndexOf('/')) || '/';
        const name = path.substring(path.lastIndexOf('/') + 1);
        if (dir !== '/') {
          const parts = dir.split('/').filter(Boolean);
          let curr = '';
          for (const p of parts) {
            curr += '/' + p;
            try {
              FS.mkdir(curr);
            } catch (e) {
              if (e.errno !== 20) throw e; // 20 = EEXIST
            }
          }
        }
        const data = new Uint8Array(files[path]);
        if (FS.analyzePath(path).exists) FS.unlink(path);
        FS.createDataFile(dir, name, data, true, true, true);
      } catch (e) {
        console.warn('[SaveManager] Could not restore:', path, e);
      }
    }
  }

  function serialize(files) {
    return btoa(JSON.stringify(files));
  }

  function deserialize(str) {
    try {
      return JSON.parse(atob(str));
    } catch (e) {
      return null;
    }
  }

  function saveToIndexedDB(files, onSuccess, onError) {
    const idb = getIndexedDB();
    if (!idb) {
      saveToLocalStorage(files, onSuccess, onError);
      return;
    }
    const req = idb.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = function() {
      var db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = function() {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.close();
          if (onError) onError(new Error('Object store not found'));
          return;
        }
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.put(serialize(files), STORAGE_KEY);
        tx.oncomplete = function() { db.close(); if (onSuccess) onSuccess(); };
        tx.onerror = function() { db.close(); if (onError) onError(tx.error); };
      } catch (e) {
        db.close();
        if (onError) onError(e);
      }
    };
    req.onerror = function() { if (onError) onError(req.error); };
  }

  function loadFromIndexedDB(onSuccess, onError) {
    const idb = getIndexedDB();
    if (!idb) {
      loadFromLocalStorage(onSuccess, onError);
      return;
    }
    const req = idb.open(IDB_NAME, IDB_VERSION);
    req.onsuccess = function() {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.close();
          if (onSuccess) onSuccess(null);
          return;
        }
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const getReq = store.get(STORAGE_KEY);
        getReq.onsuccess = function() {
          db.close();
          const data = getReq.result ? deserialize(getReq.result) : null;
          if (onSuccess) onSuccess(data);
        };
        getReq.onerror = function() { db.close(); if (onError) onError(getReq.error); };
      } catch (e) {
        db.close();
        if (onSuccess) onSuccess(null);
      }
    };
    req.onerror = function() { if (onError) onError(req.error); };
  }

  function saveToLocalStorage(files, onSuccess, onError) {
    try {
      const str = serialize(files);
      if (str.length > 4 * 1024 * 1024) {
        if (onError) onError(new Error('Save data too large for localStorage (~5MB limit)'));
        return;
      }
      global.localStorage.setItem(STORAGE_KEY, str);
      if (onSuccess) onSuccess();
    } catch (e) {
      if (onError) onError(e);
    }
  }

  function loadFromLocalStorage(onSuccess, onError) {
    try {
      const str = global.localStorage.getItem(STORAGE_KEY);
      if (onSuccess) onSuccess(str ? deserialize(str) : null);
    } catch (e) {
      if (onError) onError(e);
    }
  }

  function exportSave(FS) {
    const files = collectSaveFiles(FS);
    if (Object.keys(files).length === 0) {
      alert('No save data to export.');
      return;
    }
    const blob = new Blob([serialize(files)], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sonic1-save-' + new Date().toISOString().slice(0, 10) + '.bin';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importSave(FS, file, onSuccess, onError) {
    const r = new FileReader();
    r.onload = function() {
      const data = deserialize(r.result);
      if (!data || typeof data !== 'object') {
        if (onError) onError(new Error('Invalid save file'));
        return;
      }
      restoreSaveFiles(FS, data);
      saveToIndexedDB(data, function() {
        if (onSuccess) onSuccess();
        if (typeof onSuccess === 'undefined') alert('Save imported! You may need to restart the game.');
      }, onError);
    };
    r.onerror = function() { if (onError) onError(r.error); };
    r.readAsText(file);
  }

  function init(Module) {
    if (!Module) return;

    // Load saved data BEFORE game main() runs
    Module.preRun = Module.preRun || [];
    Module.preRun.push(function() {
      if (typeof FS === 'undefined') return;
      loadFromIndexedDB(
        function(files) {
          if (files && Object.keys(files).length > 0) {
            restoreSaveFiles(FS, files);
            console.log('[SaveManager] Restored', Object.keys(files).length, 'file(s)');
          }
        },
        function(err) { console.warn('[SaveManager] Load failed:', err); }
      );
    });

    // Auto-save on page unload / visibility change
    Module.postRun = Module.postRun || [];
    Module.postRun.push(function() {
      if (typeof FS === 'undefined') return;

      function doSave() {
        const files = collectSaveFiles(FS);
        if (Object.keys(files).length > 0) {
          saveToIndexedDB(files, function() {
            console.log('[SaveManager] Auto-saved', Object.keys(files).length, 'file(s)');
          });
        }
      }

      global.addEventListener('beforeunload', doSave);
      global.addEventListener('pagehide', doSave);
      document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') doSave();
      });

      // Expose save API globally for Export/Import buttons
      global.SonicSaveManager = {
        exportSave: function() { exportSave(FS); },
        importSave: function(file) {
          importSave(FS, file, function() {
            alert('Save imported! Please refresh the page to load your progress.');
          });
        },
        saveNow: doSave
      };
    });
  }

  if (typeof Module !== 'undefined') {
    init(Module);
  } else {
    global.SonicSaveManagerInit = init;
  }
})(typeof window !== 'undefined' ? window : this);
