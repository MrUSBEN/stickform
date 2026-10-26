// The project folder: Stickform reads and writes its own folder (presets/, models/, renders/) once the user has
// picked it. Uses the browser's File System Access API (Chrome and Edge, also from a page opened from disk). The
// folder is remembered between visits (IndexedDB); the browser may ask once per visit to allow access again.
// Opened through "Start Stickform" (the small local server in source/server), the app works in any browser and the
// folder is simply there: no picking, no permission prompt.
// Without either, or before a folder is connected, saving falls back to ordinary downloads.

type Dir = FileSystemDirectoryHandle;
type Perm = 'granted' | 'prompt' | 'denied';
interface PermHandle { queryPermission?(d: { mode: string }): Promise<Perm>; requestPermission?(d: { mode: string }): Promise<Perm> }

const DB = 'stickform', STORE = 'handles', KEY = 'project';
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise(res => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => res(undefined);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, mode), r = fn(tx.objectStore(STORE));
          r.onsuccess = () => res(r.result); r.onerror = () => res(undefined);
        } catch { res(undefined); }
      };
    } catch { res(undefined); }
  });
}

export interface ProjectFile {
  name: string; size: number; lastModified: number;
  /** The contents. */
  read(): Promise<File>;
  /** A URL to show it directly (local server only). */
  url?: string;
}
type Sub = 'presets' | 'models' | 'renders' | 'objects';
const api = (path: string, init: RequestInit = {}) => fetch(path, { ...init, headers: { 'X-Stickform': '1', ...(init.headers || {}) } });

export class Project {
  dir: Dir | null = null;
  /** Opened through the local server ("Start Stickform"): the folder is always connected. */
  server: { name: string } | null = null;
  /** A remembered folder that needs a click to allow access again. */
  pending: Dir | null = null;
  readonly pickable = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  get supported(): boolean { return this.pickable || !!this.server; }
  private listeners: (() => void)[] = [];
  onChange(f: () => void): void { this.listeners.push(f); }
  private changed(): void { this.listeners.forEach(f => f()); }

  get name(): string { return this.server?.name || this.dir?.name || this.pending?.name || ''; }
  get connected(): boolean { return !!this.dir || !!this.server; }

  /** Restore the remembered folder (no prompt), or find the local server this page came from. */
  async restore(): Promise<void> {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        const r = await api('/api/info');
        if (r.ok) { this.server = { name: (await r.json()).name }; this.changed(); return; }
      } catch { /* not served by Start Stickform */ }
    }
    if (!this.pickable) return;
    const h = await idb<Dir>('readonly', s => s.get(KEY) as IDBRequest<Dir>);
    if (!h) return;
    const p = await (h as unknown as PermHandle).queryPermission?.({ mode: 'readwrite' });
    if (p === 'granted') { this.dir = h; this.pending = null; await this.ensureFolders(); }
    else this.pending = h;
    this.changed();
  }
  /** Allow access again to the remembered folder (needs a click). */
  async reconnect(): Promise<boolean> {
    const h = this.pending; if (!h) return this.pick();
    const p = await (h as unknown as PermHandle).requestPermission?.({ mode: 'readwrite' });
    if (p !== 'granted') return false;
    this.dir = h; this.pending = null; await this.ensureFolders(); this.changed();
    return true;
  }
  /** Let the user pick the Stickform folder. */
  async pick(): Promise<boolean> {
    if (!this.pickable) return false;
    try {
      const h = await (window as unknown as { showDirectoryPicker(o: object): Promise<Dir> }).showDirectoryPicker({ id: 'stickform-project', mode: 'readwrite' });
      return this.use(h);
    } catch { return false; } // cancelled
  }
  /** Use a folder handle directly (also used by the tests with a private browser folder). */
  async use(h: Dir): Promise<boolean> {
    this.server = null; this.dir = h; this.pending = null;
    await idb('readwrite', s => s.put(h, KEY));
    await this.ensureFolders();
    this.changed();
    return true;
  }
  async disconnect(): Promise<void> { if (this.server) return; this.dir = null; this.pending = null; await idb('readwrite', s => s.delete(KEY)); this.changed(); }

  private async ensureFolders(): Promise<void> {
    if (!this.dir) return;
    for (const n of ['presets', 'models', 'renders', 'objects']) await this.dir.getDirectoryHandle(n, { create: true });
  }
  private async sub(n: Sub): Promise<Dir | null> {
    if (!this.dir) return null;
    try { return await this.dir.getDirectoryHandle(n, { create: true }); } catch { return null; }
  }
  /** Files in a subfolder, newest first. */
  async list(n: Sub, exts: string[]): Promise<ProjectFile[]> {
    const want = (name: string) => exts.some(e => name.toLowerCase().endsWith(e));
    if (this.server) {
      const r = await api(`/api/list/${n}`); if (!r.ok) return [];
      const items = (await r.json()) as { name: string; size: number; lastModified: number }[];
      return items.filter(i => want(i.name)).map(i => {
        const url = `/api/file/${n}/${encodeURIComponent(i.name)}`;
        return { ...i, url: url + '?k=' + Math.round(i.lastModified), read: async () => {
          const f = await api(url); if (!f.ok) throw new Error(`Could not read ${n}/${i.name}`);
          return new File([await f.blob()], i.name, { lastModified: i.lastModified });
        } };
      }).sort((a, b) => b.lastModified - a.lastModified);
    }
    const d = await this.sub(n); if (!d) return [];
    const out: ProjectFile[] = [];
    for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind !== 'file' || !want(name)) continue;
      try { const f = await (h as FileSystemFileHandle).getFile(); out.push({ name, size: f.size, lastModified: f.lastModified, read: async () => f }); } catch { /* unreadable: skip */ }
    }
    return out.sort((a, b) => b.lastModified - a.lastModified);
  }
  /** Can this subfolder be used? (An older Start Stickform window does not know objects/.) */
  async check(n: Sub): Promise<boolean> {
    if (this.server) { try { return (await api(`/api/list/${n}`)).ok; } catch { return false; } }
    return !!(await this.sub(n));
  }
  async exists(n: Sub, name: string): Promise<boolean> {
    if (this.server) return (await api(`/api/file/${n}/${encodeURIComponent(name)}`, { method: 'HEAD' })).ok;
    const d = await this.sub(n); if (!d) return false;
    try { await d.getFileHandle(name); return true; } catch { return false; }
  }
  async write(n: Sub, name: string, data: Blob | ArrayBuffer | string): Promise<void> {
    if (this.server) {
      const r = await api(`/api/file/${n}/${encodeURIComponent(name)}`, { method: 'PUT', body: data });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not write ${n}/${name}`);
      return;
    }
    const d = await this.sub(n); if (!d) throw new Error('No project folder');
    const fh = await d.getFileHandle(name, { create: true });
    const w = await (fh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(data as Blob); await w.close();
  }
  /** Rename a file in the same subfolder. Refuses to replace an existing file. */
  async rename(n: Sub, from: string, to: string): Promise<void> {
    if (from === to) return;
    if (this.server) {
      const r = await api(`/api/rename/${n}/${encodeURIComponent(from)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not rename ${n}/${from}`);
      return;
    }
    const d = await this.sub(n); if (!d) throw new Error('No project folder');
    if (from.toLowerCase() !== to.toLowerCase() && await this.exists(n, to)) throw new Error(`${n}/${to} already exists`);
    const fh = await d.getFileHandle(from);
    const mv = (fh as unknown as { move?(name: string): Promise<void> }).move;
    if (mv) { try { await mv.call(fh, to); return; } catch { /* not supported for this folder: copy instead */ } }
    const data = await fh.getFile();
    await this.write(n, to, data);
    await d.removeEntry(from);
  }
  async remove(n: Sub, name: string): Promise<void> {
    if (this.server) { const r = await api(`/api/file/${n}/${encodeURIComponent(name)}`, { method: 'DELETE' }); if (!r.ok) throw new Error(`Could not delete ${n}/${name}`); return; }
    const d = await this.sub(n); if (!d) return;
    await d.removeEntry(name);
  }
}

/** "Ask where to save": a save dialog for one file (Chrome and Edge); false if cancelled or unsupported. */
export async function saveAs(name: string, data: Blob, type: { description: string; accept: Record<string, string[]> }): Promise<boolean | null> {
  const w = window as unknown as { showSaveFilePicker?(o: object): Promise<FileSystemFileHandle> };
  if (!w.showSaveFilePicker) return null;
  try {
    const h = await w.showSaveFilePicker({ suggestedName: name, types: [type] });
    const s = await (h as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await s.write(data); await s.close();
    return true;
  } catch { return false; }
}

export function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(','), mime = head.match(/data:([^;]+)/)?.[1] || 'application/octet-stream';
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
