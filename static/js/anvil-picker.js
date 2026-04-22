/**
 * anvil-picker.js — Audio file picker with sticky folder anchoring.
 *
 * Chrome/Edge only (via File System Access API). Firefox and other browsers
 * silently fall back to a plain <input type="file"> so drop-zones keep
 * working everywhere.
 *
 * The "sticky" behavior: after the user picks a file from a particular
 * folder for a particular scope (e.g. "mix-source"), the next pick for
 * that same scope opens the dialog in that folder. Saved handles persist
 * across browser restarts via IndexedDB.
 *
 * Usage:
 *   const file = await AnvilPicker.pick({
 *     scope:  "mix-source",
 *     accept: { "audio/wav": [".wav", ".flac", ".aiff", ".aif"] },
 *     fallbackStartIn: "music",
 *     inputElement: document.getElementById("my-hidden-input"),
 *   });
 *   // file is a File object (or null if user cancelled)
 *
 * Why not derive the folder from the picked file? The File System Access
 * API doesn't expose directory handles from file handles for security
 * reasons. BUT showOpenFilePicker's startIn option accepts a FileSystemHandle
 * of any kind — so we save the FILE handle from the previous pick and pass
 * it as startIn; Chrome opens the dialog in that file's parent folder.
 */

(function () {
  "use strict";

  // ---------- IndexedDB wrapper ----------
  // We need IDB (not localStorage) because FileSystemHandle objects are
  // structured-clonable but not JSON-serializable. Storing them in IDB
  // preserves them across reloads; localStorage would lose them.

  const DB_NAME = "anvil_pickers";
  const DB_VERSION = 1;
  const STORE = "handles";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
  }

  async function idbSet(key, value) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => reject(tx.error);
      });
    } catch (e) {
      return false;
    }
  }

  async function idbDelete(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => reject(tx.error);
      });
    } catch (e) {
      return false;
    }
  }

  // ---------- Permission re-check ----------
  // Chrome may have persisted the handle but revoked the permission (e.g.
  // after a restart or extended inactivity). queryPermission returns
  // "granted" / "prompt" / "denied". We treat anything non-granted as
  // "handle is stale" — drop it and fall back. We don't call
  // requestPermission because that REQUIRES a user gesture; doing it
  // silently without one raises SecurityError.
  async function handleIsUsable(handle) {
    if (!handle || typeof handle.queryPermission !== "function") return false;
    try {
      const state = await handle.queryPermission({ mode: "read" });
      return state === "granted";
    } catch (e) {
      return false;
    }
  }

  // ---------- Public API ----------

  /**
   * Pick an audio file with sticky folder anchoring.
   *
   * @param {object}   opts
   * @param {string}   opts.scope            — IDB key, one per UI picker
   *                                           (e.g. "mix-source", "master-source")
   * @param {object}   opts.accept           — MIME→extensions map for the filter
   *                                           (e.g. {"audio/wav":[".wav",".flac"]})
   * @param {string}   opts.fallbackStartIn  — well-known location hint for
   *                                           first-ever pick ("music", "downloads"...)
   * @param {Element}  opts.inputElement     — hidden <input type="file"> used as
   *                                           fallback when File System Access API
   *                                           isn't available
   * @returns {Promise<File|null>}           — picked file, or null if user
   *                                           cancelled. Rejects only on
   *                                           unexpected errors.
   */
  async function pick({ scope, accept, fallbackStartIn, inputElement }) {
    // Modern path: File System Access API. Chrome/Edge desktop, Opera.
    if (typeof window.showOpenFilePicker === "function") {
      const savedHandle = await idbGet(scope);
      const usable = await handleIsUsable(savedHandle);

      const pickerOpts = {
        types: [{
          description: "Audio files",
          accept: accept || { "audio/*": [".wav", ".flac", ".aiff", ".aif", ".mp3"] },
        }],
        multiple: false,
        excludeAcceptAllOption: false,
      };
      // startIn accepts either a well-known string OR a FileSystemHandle.
      // If we have a usable saved handle, use it to anchor the dialog to
      // that file's parent folder. Otherwise fall back to a category hint.
      pickerOpts.startIn = usable ? savedHandle : (fallbackStartIn || "music");

      try {
        const [fileHandle] = await window.showOpenFilePicker(pickerOpts);
        // Save the fresh handle for next time — even if it's the same file,
        // refreshing it keeps the permission chain alive.
        idbSet(scope, fileHandle);
        return await fileHandle.getFile();
      } catch (err) {
        if (err && err.name === "AbortError") return null;  // user cancelled
        // Any other error: fall through to the <input> path rather than
        // surfacing a cryptic message. This catches edge cases like stale
        // handles where queryPermission lied.
        if (savedHandle) idbDelete(scope);
        console.warn("[anvil-picker] showOpenFilePicker failed, falling back:", err);
      }
    }

    // Fallback path: plain <input type="file">. Works everywhere, no sticky
    // folder behavior available. The caller is expected to provide the
    // input element; we just click it and wait for the change event.
    if (!inputElement) return null;
    return await new Promise((resolve) => {
      const onChange = () => {
        inputElement.removeEventListener("change", onChange);
        const f = inputElement.files && inputElement.files[0];
        // Reset so the same file can be re-selected next time (a file input
        // doesn't re-fire 'change' for the same path by default).
        inputElement.value = "";
        resolve(f || null);
      };
      inputElement.addEventListener("change", onChange);
      inputElement.click();
    });
  }

  /**
   * Forget the saved folder for a given scope. Useful for a "reset folder
   * memory" user action if we ever add one. Not currently wired up.
   */
  async function clearScope(scope) {
    await idbDelete(scope);
  }

  // Expose on window for page scripts to use.
  window.AnvilPicker = {
    pick:       pick,
    clearScope: clearScope,
  };
})();
