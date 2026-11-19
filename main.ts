import { Buffer } from "buffer";
import git, { GitHttpRequest, GitHttpResponse } from "isomorphic-git";
import {
  App, DataAdapter, ItemView, Notice, Plugin, PluginSettingTab, Setting, Stat, WorkspaceLeaf,
  RequestUrlResponse, normalizePath, requestUrl,
} from "obsidian";

// isomorphic-git needs Node's Buffer; Obsidian mobile has none.
(globalThis as any).Buffer ??= Buffer;

// synced: repo -> last successful sync (ms). merging: repo -> unfinished merge waiting for the user.
interface Settings {
  login: string; id: number; expires: number;
  synced: Record<string, number>;
  merging: Record<string, { theirs: string; files: string[] }>;
}
const DEFAULTS: Settings = { login: "", id: 0, expires: 0, synced: {}, merging: {} };
// GitHub App "Obsidian-GitHub-Connect", owned by and installable only on IsometriaInternal.
const CLIENT_ID = "Iv23liN72h2n3K7zuhDS"; // public by design: device flow has no secret
const OWNER = "IsometriaInternal";
const SECRET = "github-connect-token";
const REFRESH = "github-connect-refresh";
const VIEW = "github-vaults";
const FORM = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };

export default class GitHubConnect extends Plugin {
  s: Settings = { ...DEFAULTS };
  base = "https://github.com"; // git host; tests point it at a local server
  busy = new Set<string>();
  // Background jobs: run in the plugin, not in any view, so closing the panel doesn't stop them.
  jobs = new Map<string, { step: string; frac?: number; t0: number }>();
  errors: Record<string, string> = {};
  names?: string[]; // cached vault list
  listeners = new Set<(structural: boolean) => void>();
  statusEl?: HTMLElement;

  // Token lives in Obsidian's secret storage, not in the vault's data.json.
  get token() { return this.app.secretStorage.getSecret(SECRET) ?? ""; }
  set token(v: string) { this.app.secretStorage.setSecret(SECRET, v); }
  get refresh() { return this.app.secretStorage.getSecret(REFRESH) ?? ""; }
  set refresh(v: string) { this.app.secretStorage.setSecret(REFRESH, v); }
  renewing?: Promise<boolean>;

  // Expiring tokens: 8h access token + refresh token. Without expiry GitHub sends no expires_in.
  keep(t: { access_token: string; refresh_token?: string; expires_in?: number }) {
    this.token = t.access_token;
    this.refresh = t.refresh_token ?? "";
    this.s.expires = t.expires_in ? Date.now() + t.expires_in * 1000 : 0;
  }

  async signOut() {
    this.token = this.refresh = this.s.login = "";
    this.names = undefined;
    this.s.expires = this.s.id = 0;
    await this.save();
  }

  // Device-flow tokens refresh without a client secret (GitHub docs). One refresh at a time:
  // refresh tokens rotate, so a second parallel refresh with the old one would fail.
  renew() {
    return (this.renewing ??= (async () => {
      if (!this.refresh) return false;
      const t = (await requestUrl({ url: "https://github.com/login/oauth/access_token", method: "POST", throw: false, headers: FORM,
        body: `client_id=${CLIENT_ID}&grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refresh)}` })).json;
      if (!t.access_token) return false;
      this.keep(t);
      await this.save();
      return true;
    })().finally(() => (this.renewing = undefined)));
  }

  async fresh() {
    if (this.s.expires && Date.now() > this.s.expires - 60_000) await this.renew();
  }

  async onload() {
    const d = (await this.loadData()) ?? {};
    if (d.token) { this.token = d.token; delete d.token; } // move 0.1.0 plaintext token out of data.json
    this.s = { ...DEFAULTS, synced: {}, merging: {}, ...d };
    await this.save();
    this.addSettingTab(new Tab(this.app, this));
    this.registerView(VIEW, (leaf) => new VaultsView(leaf, this));
    this.addRibbonIcon("github", "GitHub vaults", () => this.openView());
    this.statusEl = this.addStatusBarItem(); // desktop only; mobile has no status bar
    // First run (nothing pulled yet): open the panel so nobody has to find the icon.
    this.app.workspace.onLayoutReady(() => { if (!Object.keys(this.s.synced).length) this.openView(); });
    this.addCommand({ id: "sign-in", name: "Sign in", callback: () => this.signIn().catch((e) => new Notice(`GitHub: ${e.message}`)) });
    this.addCommand({ id: "vaults", name: "Open vaults", callback: () => this.openView() });
    this.addCommand({ id: "sync-current", name: "Sync the vault of the current note", checkCallback: (checking) => {
      const repo = this.app.workspace.getActiveFile()?.path.split("/")[0];
      if (!repo || !this.s.synced[repo]) return false;
      if (!checking) this.run(repo);
      return true;
    } });
  }

  save() { return this.saveData(this.s); }

  async openView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = ws.getRightLeaf(false)!; await leaf.setViewState({ type: VIEW, active: true }); }
    ws.revealLeaf(leaf);
  }

  // Start Pull / Link / Sync in the background; progress goes to listeners and the status bar.
  run(repo: string) {
    if (this.jobs.has(repo)) return;
    delete this.errors[repo];
    this.jobs.set(repo, { step: "Starting", t0: Date.now() });
    this.changed(true);
    this.sync(repo, (step, frac) => { this.jobs.set(repo, { ...this.jobs.get(repo)!, step, frac }); this.changed(false); })
      .then((m) => { new Notice(`${repo}: ${m}`); },
        (e) => { this.errors[repo] = e.message; new Notice(`${repo}: ${e.message}`, 15000); })
      .finally(() => { this.jobs.delete(repo); this.changed(true); });
  }

  changed(structural: boolean) {
    const [repo, j] = [...this.jobs][0] ?? [];
    this.statusEl?.setText(j ? `GitHub: ${repo} ${jobText(j)}${this.jobs.size > 1 ? ` (+${this.jobs.size - 1})` : ""}` : "");
    this.listeners.forEach((f) => f(structural));
  }

  // OAuth device flow: only the public client ID is needed, no secret ships in the plugin.
  async signIn() {
    const d = (await requestUrl({ url: "https://github.com/login/device/code", method: "POST", throw: false,
      headers: FORM, body: `client_id=${CLIENT_ID}` })).json;
    if (!d.device_code) return new Notice(`GitHub: ${d.error_description ?? d.error ?? "check the client ID and that Device Flow is enabled"}`);
    // iOS may refuse clipboard writes after an await; the notice still shows the code.
    const copied = await navigator.clipboard.writeText(d.user_code).then(() => true, () => false);
    const n = new Notice(`Code ${d.user_code}${copied ? " (copied)" : ""}. Enter it on the GitHub page.`, 0);
    window.open(d.verification_uri);

    let wait: number = d.interval;
    const deadline = Date.now() + d.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep(wait * 1000);
      const t = (await requestUrl({ url: "https://github.com/login/oauth/access_token", method: "POST", throw: false, headers: FORM,
        body: `client_id=${CLIENT_ID}&device_code=${d.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code` })).json;
      if (t.access_token) {
        this.keep(t);
        const me = (await this.gh("/user")).json;
        this.s.login = me.login; this.s.id = me.id;
        await this.save();
        n.hide();
        return new Notice(`Signed in as ${this.s.login}`);
      }
      if (t.error === "slow_down") wait = t.interval ?? wait + 5;
      else if (t.error !== "authorization_pending") { n.hide(); return new Notice(`GitHub login failed: ${t.error}`); }
    }
    n.hide();
    new Notice("GitHub login timed out");
  }

  async gh(path: string, method = "GET", body?: object, retry = true): Promise<RequestUrlResponse> {
    await this.fresh();
    const r = await requestUrl({ url: `https://api.github.com${path}`, method, throw: false,
      body: body && JSON.stringify(body),
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json" } });
    if (r.status === 401) {
      if (retry && (await this.renew())) return this.gh(path, method, body, false);
      await this.signOut();
      throw new Error("session expired, run Sign in again");
    }
    return r;
  }

  async json(path: string) {
    const r = await this.gh(path);
    if (r.status >= 400) throw new Error(r.json?.message ?? `HTTP ${r.status}`);
    return r.json;
  }

  // Vaults = OWNER repos the app is installed on AND this user can access (GitHub does the intersection).
  async vaults(): Promise<string[]> {
    const { installations } = await this.json("/user/installations?per_page=100");
    const inst = installations.find((i: any) => i.account.login.toLowerCase() === OWNER.toLowerCase());
    if (!inst) return [];
    const names: string[] = [];
    for (let page = 1; ; page++) {
      const r = await this.json(`/user/installations/${inst.id}/repositories?per_page=100&page=${page}`);
      names.push(...r.repositories.map((x: any) => x.name));
      if (!r.repositories.length || names.length >= r.total_count) break;
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  // Shared options for every isomorphic-git call. Each vault folder "<repo>/" is its own git repo.
  get g() {
    const auth = () => ({ username: "x-access-token", password: this.token });
    return {
      fs: vaultFs(this.app.vault.adapter), http: { request: gitHttp }, onAuth: auth,
      onAuthFailure: async () => ((await this.renew()) ? auth() : { cancel: true }),
    };
  }

  get author() {
    return { name: this.s.login, email: `${this.s.id ? `${this.s.id}+` : ""}${this.s.login}@users.noreply.github.com` };
  }

  // Pull (first time: shallow clone) or sync: commit local changes, fetch, merge, push.
  // Returns a one-line summary; throws with a readable message.
  async sync(repo: string, say: (step: string, done?: number) => void): Promise<string> {
    if (!this.token) throw new Error("sign in first");
    if (this.busy.has(repo)) throw new Error("already syncing");
    this.busy.add(repo);
    try {
      await this.fresh();
      const g = this.g, fs = g.fs, dir = repo, a = this.app.vault.adapter;
      // done = 0..1 when git knows the total, undefined while waiting (e.g. the download itself).
      const onProgress = (p: { phase: string; loaded: number; total?: number }) =>
        say(p.phase, p.total ? p.loaded / p.total : undefined);

      // A .git that never finished a Pull on this device (app closed mid-download, out of memory) holds
      // nothing of the user's: drop it and link the folder again. Notes in the folder are not touched.
      let unfinished = false;
      if (!this.s.synced[repo] && (await a.exists(`${repo}/.git`))) {
        say("Cleaning up an unfinished pull");
        await a.rmdir(`${repo}/.git`, true);
        unfinished = true;
      }

      if (!(await a.exists(`${repo}/.git`))) {
        if (await a.exists(repo)) {
          try { return this.done(repo, await this.adopt(repo, onProgress, unfinished)); }
          catch (e) { await a.rmdir(`${repo}/.git`, true).catch(() => {}); throw e; } // undo only what we added
        }
        say("Downloading");
        try {
          await git.clone({ ...g, dir, url: `${this.base}/${OWNER}/${repo}.git`, depth: 1, singleBranch: true, noTags: true, onProgress });
        } catch (e) {
          if (await a.exists(repo)) await a.rmdir(repo, true); // a half-cloned folder would block the next Pull
          throw e;
        }
        // Empty repo: isomorphic-git would start on "master"; GitHub's default is "main".
        if (!(await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null)))
          await git.writeRef({ fs, dir, ref: "HEAD", value: "refs/heads/main", symbolic: true, force: true });
        return this.done(repo, "pulled");
      }

      const author = this.author, branch = (await git.currentBranch({ fs, dir })) ?? "main";

      // Pulled while the repo was empty, and GitHub has commits now: link to them like an existing
      // folder (notes made here meanwhile are kept and sent on the next Sync).
      if (!(await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null))) {
        say("Checking GitHub");
        await git.fetch({ ...g, dir, singleBranch: true, ref: branch, tags: false });
        if (await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }).catch(() => null)) {
          await a.rmdir(`${repo}/.git`, true);
          return this.done(repo, await this.adopt(repo, onProgress));
        }
      }
      const merging = this.s.merging[repo];
      if (merging) {
        for (const f of merging.files)
          if ((await a.exists(`${repo}/${f}`)) && (await a.read(`${repo}/${f}`)).includes("<<<<<<<"))
            throw new Error(`still has conflict markers: ${f}. Edit it, then Sync`);
      }

      say("Saving your changes");
      const changed = await stageAll(fs, dir);
      if (merging) {
        const ours = await git.resolveRef({ fs, dir, ref: "HEAD" });
        await git.commit({ fs, dir, author, parent: [ours, merging.theirs], message: `Merge from GitHub (resolved in Obsidian by ${author.name})` });
        delete this.s.merging[repo];
        await this.save();
      } else if (changed) {
        await git.commit({ fs, dir, author, message: `Obsidian: ${changed} file${changed > 1 ? "s" : ""} by ${author.name}` });
      }

      say("Downloading new commits");
      // No depth here: in a shallow repo this brings only the commits since our last sync.
      await git.fetch({ ...g, dir, singleBranch: true, ref: branch, tags: false, onProgress });
      const theirs = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }).catch(() => null);
      const before = await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null);
      if (!before) return this.done(repo, "empty: add a note to this folder, then Sync");
      if (theirs) try {
        await git.merge({ fs, dir, ours: branch, theirs, author, abortOnConflict: false,
          message: `Merge from GitHub into ${author.name}'s Obsidian` });
      } catch (e: any) {
        if (e?.code !== "MergeConflictError") throw e;
        const files = e.data.bothModified.length ? e.data.bothModified : e.data.filepaths;
        this.s.merging[repo] = { theirs, files };
        await this.save();
        throw new Error(`edited here and on GitHub: ${files.join(", ")}. Fix the <<<<<<< / >>>>>>> parts in those notes, then Sync`);
      }
      if ((await git.resolveRef({ fs, dir, ref: "HEAD" })) !== before) {
        say("Updating notes");
        await git.checkout({ fs, dir, ref: branch, onProgress });
      }

      say("Sending");
      const r = await git.push({ ...g, dir, ref: branch, onProgress });
      if (!r.ok) throw new Error(`GitHub refused the push: ${r.error ?? "unknown"}`);
      return this.done(repo, changed ? `${changed} change${changed > 1 ? "s" : ""} sent` : "up to date");
    } finally {
      this.busy.delete(repo);
    }
  }

  // Turn an existing folder (e.g. pulled by 0.4.0 without git) into a git repo in place. Never overwrites
  // a local edit: 0.4.0's per-file record (s.base, "<repo>/<path>" -> blob sha) tells untouched files
  // from edited ones. Untouched or missing files get GitHub's version; edited and new ones wait for Sync.
  // fromUnfinishedPull: the folder's copies of repo files came from our own interrupted clone, not from
  // the user, so (without a 0.4.0 record) GitHub's version wins for them; notes not in the repo are kept.
  async adopt(repo: string, onProgress: (p: any) => void, fromUnfinishedPull = false) {
    const g = this.g, fs = g.fs, dir = repo, a = this.app.vault.adapter;
    const base: Record<string, string> = (this.s as any).base ?? {};
    const trustRemote = fromUnfinishedPull && !Object.keys(base).some((k) => k.startsWith(`${repo}/`));
    await git.init({ fs, dir, defaultBranch: "main" });
    await git.addRemote({ fs, dir, remote: "origin", url: `${this.base}/${OWNER}/${repo}.git` });
    onProgress({ phase: "Downloading", loaded: 0 });
    const f = await git.fetch({ ...g, dir, depth: 1, singleBranch: true, tags: false, onProgress });
    if (!f.fetchHead) return "linked (GitHub repo is empty)";
    const branch = (f.defaultBranch ?? "refs/heads/main").replace("refs/heads/", "");
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: f.fetchHead, force: true });
    await git.writeRef({ fs, dir, ref: `refs/remotes/origin/${branch}`, value: f.fetchHead, force: true });
    await git.writeRef({ fs, dir, ref: "HEAD", value: `refs/heads/${branch}`, symbolic: true, force: true });
    await git.setConfig({ fs, dir, path: `branch.${branch}.remote`, value: "origin" });
    await git.setConfig({ fs, dir, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });

    const take: string[] = [];
    let kept = 0;
    for (const file of await git.listFiles({ fs, dir, ref: f.fetchHead })) {
      const local = `${repo}/${file}`;
      if (!(await a.exists(local))) { take.push(file); continue; }
      const { oid } = await git.hashBlob({ object: new Uint8Array(await a.readBinary(local)) });
      const remote = (await git.readBlob({ fs, dir, oid: f.fetchHead, filepath: file })).oid;
      if (oid === remote) take.push(file); // same content: just record it in the index
      else if (base[local] && oid === base[local]) take.push(file); // untouched here, changed on GitHub
      else if (trustRemote) take.push(file); // left over from our interrupted clone
      else kept++; // edited here (or unknown): keep, Sync will commit it
    }
    if (take.length) await git.checkout({ fs, dir, ref: branch, filepaths: take, force: true, onProgress });
    return kept ? `linked; ${kept} note${kept > 1 ? "s" : ""} edited here will be sent on Sync` : "linked";
  }

  async done(repo: string, msg: string) {
    this.s.synced[repo] = Date.now();
    await this.save();
    return msg;
  }
}

// git add -A; returns how many files changed since the last commit.
async function stageAll(fs: ReturnType<typeof vaultFs>, dir: string) {
  let n = 0;
  for (const [filepath, head, work, stage] of await git.statusMatrix({ fs, dir })) {
    if (head === 1 && work === 1 && stage === 1) continue;
    if (work === 0) { if (stage) await git.remove({ fs, dir, filepath }); }
    else await git.add({ fs, dir, filepath });
    if (!(head === 1 && work === 1)) n++;
  }
  return n;
}

// isomorphic-git over Obsidian's file adapter, so the same code works on desktop and mobile.
export function vaultFs(a: DataAdapter) {
  const p = (x: string) => normalizePath(x);
  const fail = (code: string, x: string) => Object.assign(new Error(`${code}: ${x}`), { code });
  const parentOf = (x: string) => (x.includes("/") ? x.slice(0, x.lastIndexOf("/")) : "");
  const stats = (s: Stat) => ({
    type: s.type === "folder" ? "dir" : "file", mode: s.type === "folder" ? 0o40000 : 0o100644, size: s.size,
    ino: 0, uid: 0, gid: 0, dev: 0, ctimeMs: s.ctime, mtimeMs: s.mtime,
    isFile: () => s.type === "file", isDirectory: () => s.type === "folder", isSymbolicLink: () => false,
  });
  const must = async (x: string) => { const s = await a.stat(x); if (!s) throw fail("ENOENT", x); return s; };
  const promises = {
    async readFile(path: string, opts?: string | { encoding?: string }) {
      const x = p(path);
      if ((await must(x)).type === "folder") throw fail("EISDIR", x);
      const buf = await a.readBinary(x);
      return (typeof opts === "string" ? opts : opts?.encoding) ? new TextDecoder().decode(buf) : new Uint8Array(buf);
    },
    async writeFile(path: string, data: string | Uint8Array) {
      const x = p(path), dir = parentOf(x);
      if (dir && !(await a.exists(dir))) throw fail("ENOENT", x);
      const b = typeof data === "string" ? new TextEncoder().encode(data) : data;
      await a.writeBinary(x, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    },
    async mkdir(path: string) {
      const x = p(path), dir = parentOf(x);
      if (await a.exists(x)) throw fail("EEXIST", x);
      if (dir && !(await a.exists(dir))) throw fail("ENOENT", x);
      await a.mkdir(x);
    },
    async rmdir(path: string) {
      const x = p(path), l = await a.list(x);
      if (l.files.length || l.folders.length) throw fail("ENOTEMPTY", x);
      await a.rmdir(x, false);
    },
    async unlink(path: string) { const x = p(path); await must(x); await a.remove(x); },
    async stat(path: string) { return stats(await must(p(path))); },
    async lstat(path: string) { return stats(await must(p(path))); },
    async readdir(path: string) {
      const x = p(path);
      if ((await must(x)).type !== "folder") throw fail("ENOTDIR", x);
      const l = await a.list(x);
      return [...l.files, ...l.folders].map((f) => f.slice(f.lastIndexOf("/") + 1));
    },
    async readlink(path: string): Promise<string> { throw fail("ENOENT", path); },
    async symlink(_t: string, path: string) { throw fail("ENOSYS", path); },
  };
  return { promises };
}

// isomorphic-git HTTP through requestUrl: no CORS limits, works on mobile.
export async function gitHttp({ url, method = "GET", headers = {}, body }: GitHttpRequest): Promise<GitHttpResponse> {
  let data: ArrayBuffer | undefined;
  if (body) {
    const parts: Uint8Array[] = [];
    for await (const c of body as AsyncIterable<Uint8Array>) parts.push(c);
    const all = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of parts) { all.set(c, o); o += c.length; }
    data = all.buffer;
  }
  const r = await requestUrl({ url, method, headers, body: data, throw: false });
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) h[k.toLowerCase()] = v;
  const bytes = new Uint8Array(r.arrayBuffer);
  return { url, method, statusCode: r.status, statusMessage: String(r.status), headers: h, body: (async function* () { yield bytes; })() };
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

const jobText = (j: { step: string; frac?: number; t0: number }) =>
  j.frac === undefined ? `${j.step} · ${Math.round((Date.now() - j.t0) / 1000)} s` : `${j.step} ${Math.round(j.frac * 100)}%`;

// Right-sidebar panel: one row per vault the user can access, each with its own Pull / Link / Sync button.
class VaultsView extends ItemView {
  rows = new Map<string, { label: HTMLElement; bar: HTMLProgressElement }>();
  gen = 0;
  constructor(leaf: WorkspaceLeaf, private p: GitHubConnect) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return "GitHub vaults"; }
  getIcon() { return "github"; }

  onChange = (structural: boolean) => (structural ? this.render() : this.tick());

  async onOpen() {
    this.addAction("refresh-cw", "Reload vault list", () => { this.p.names = undefined; this.render(); });
    this.p.listeners.add(this.onChange);
    this.registerInterval(window.setInterval(() => this.tick(), 1000)); // elapsed seconds while downloading
    this.render();
  }

  async onClose() { this.p.listeners.delete(this.onChange); }

  tick() {
    for (const [repo, r] of this.rows) {
      const j = this.p.jobs.get(repo);
      if (!j) continue;
      r.label.setText(jobText(j));
      if (j.frac === undefined) r.bar.removeAttribute("value"); else r.bar.value = j.frac;
    }
  }

  async render() {
    const id = ++this.gen, p = this.p, el = this.contentEl, a = p.app.vault.adapter;
    if (!p.token) {
      el.empty();
      new Setting(el).setName("Not signed in").addButton((b) => b.setButtonText("Sign in").setCta()
        .onClick(async () => { await p.signIn(); this.render(); }));
      return;
    }
    if (!p.names) {
      el.empty();
      el.createEl("p", { text: "Loading vaults…" });
      try { p.names = await p.vaults(); }
      catch (e: any) { if (id === this.gen) { el.empty(); el.createEl("p", { text: `Could not load vaults: ${e.message}` }); } return; }
    }
    // Gather state first, then draw in one go, so overlapping renders can't duplicate rows.
    const info = await Promise.all(p.names.map(async (name) => {
      const here = await a.exists(`${name}/.git`);
      return { name, here, folder: here || (await a.exists(name)) };
    }));
    if (id !== this.gen) return;
    el.empty();
    this.rows.clear();
    if (!info.length) el.createEl("p", { text: "No vaults yet. Ask an org owner to add the app to a repo." });
    for (const { name, here, folder } of info) {
      const row = new Setting(el).setName(name), job = p.jobs.get(name), m = p.s.merging[name];
      if (job) {
        const label = row.descEl.createDiv(), bar = row.descEl.createEl("progress", { attr: { max: "1" } });
        bar.style.width = "100%";
        this.rows.set(name, { label, bar });
      } else {
        row.setDesc(p.errors[name] ? `Failed: ${p.errors[name]}`
          : m ? `Conflicts to fix: ${m.files.join(", ")}`
          : here ? `In folder ${name}/ · synced ${p.s.synced[name] ? ago(p.s.synced[name]) : "never"}`
          : folder ? `Folder ${name}/ is here but not linked to git yet. Your notes are kept.` : "Not on this device");
      }
      row.addButton((b) => {
        b.setButtonText(job ? "Working…" : here ? "Sync" : folder ? "Link" : "Pull").setDisabled(!!job).onClick(() => p.run(name));
        if (!here && !folder && !job) b.setCta();
      });
    }
    this.tick();
  }
}

class Tab extends PluginSettingTab {
  constructor(app: App, private p: GitHubConnect) { super(app, p); }

  display() {
    const { containerEl: el, p } = this;
    el.empty();
    new Setting(el).setName("Account")
      .setDesc(p.token ? `Signed in as ${p.s.login}` : "Not signed in")
      .addButton((b) => b.setButtonText(p.token ? "Sign out" : "Sign in").onClick(async () => {
        if (p.token) await p.signOut(); else await p.signIn();
        this.display();
      }));
    new Setting(el).setName("Vaults")
      .setDesc(`Pull or sync any ${OWNER} repo you can access, in the right sidebar. Also on the ribbon (GitHub icon).`)
      .addButton((b) => b.setButtonText("Open vaults").setCta().onClick(() => p.openView()));
    new Setting(el).setName("Repository access")
      .setDesc(`The app only reaches ${OWNER} repos it is installed on. Org owners pick them here.`)
      .addButton((b) => b.setButtonText("Manage").onClick(() =>
        window.open(`https://github.com/organizations/${OWNER}/settings/installations`)));
  }
}
