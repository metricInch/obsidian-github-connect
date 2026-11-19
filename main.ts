import {
  App, Notice, Plugin, PluginSettingTab, Setting, SuggestModal, TFile,
  RequestUrlResponse, arrayBufferToBase64, base64ToArrayBuffer, requestUrl,
} from "obsidian";

// vaults: repo -> branch it was pulled from (repo lives in vault folder "<repo>/").
// base: "<repo>/<path>" -> git blob sha at the last sync, to tell local edits from remote ones.
interface Settings { login: string; expires: number; vaults: Record<string, string>; base: Record<string, string> }
const DEFAULTS: Settings = { login: "", expires: 0, vaults: {}, base: {} };
// GitHub App "Obsidian-GitHub-Connect", owned by and installable only on IsometriaInternal.
const CLIENT_ID = "Iv23liN72h2n3K7zuhDS"; // public by design: device flow has no secret
const OWNER = "IsometriaInternal";
const SECRET = "github-connect-token";
const REFRESH = "github-connect-refresh";
const FORM = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };

export default class GitHubConnect extends Plugin {
  s: Settings = { ...DEFAULTS };

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
    this.s.expires = 0;
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

  async onload() {
    const d = (await this.loadData()) ?? {};
    if (d.token) { this.token = d.token; delete d.token; } // move 0.1.0 plaintext token out of data.json
    this.s = { ...DEFAULTS, vaults: {}, base: {}, ...d };
    await this.save();
    this.addSettingTab(new Tab(this.app, this));
    this.addCommand({ id: "sign-in", name: "Sign in", callback: () => this.signIn().catch((e) => new Notice(`GitHub: ${e.message}`)) });
    this.addCommand({ id: "pull-vault", name: "Pull a vault", callback: () => this.pickVault() });
    this.addCommand({ id: "push-note", name: "Push current note", checkCallback: (c) => this.onNote(c, (f) => this.push(f)) });
    this.addCommand({ id: "pull-note", name: "Pull current note", checkCallback: (c) => this.onNote(c, (f) => this.pull(f)) });
  }

  save() { return this.saveData(this.s); }

  onNote(checking: boolean, fn: (f: TFile) => Promise<void>) {
    const f = this.app.workspace.getActiveFile();
    if (!f || !this.where(f)) return false; // only notes inside a pulled vault folder
    if (!checking) fn(f).catch((e) => new Notice(`GitHub: ${e.message}`));
    return true;
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
        this.s.login = (await this.gh("/user")).json.login;
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
    if (this.s.expires && Date.now() > this.s.expires - 60_000) await this.renew();
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

  where(f: TFile) {
    const [repo, ...rest] = f.path.split("/");
    return rest.length && this.s.vaults[repo] ? { repo, path: rest.join("/"), branch: this.s.vaults[repo] } : null;
  }

  async pickVault() {
    if (!this.token) return new Notice("GitHub: sign in first");
    const names = await this.vaults().catch((e) => { new Notice(`GitHub: ${e.message}`); return null; });
    if (!names) return;
    if (!names.length) return new Notice(`No ${OWNER} vaults: ask an org owner to add the app to a repo`);
    new VaultPicker(this, names).open();
  }

  // Pull every file of a repo into "<repo>/". Unchanged files are skipped without downloading;
  // files edited locally since the last sync are left alone and reported.
  async pullVault(repo: string) {
    const n = new Notice(`Pulling ${repo}…`, 0);
    try {
      const branch = this.s.vaults[repo] ?? (await this.json(`/repos/${OWNER}/${repo}`)).default_branch;
      const tree = await this.json(`/repos/${OWNER}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      this.s.vaults[repo] = branch;
      const count = { wrote: 0, same: 0, conflict: [] as string[] };
      for (const e of tree.tree) {
        // ponytail: skips dot-paths (.obsidian, .github, .gitignore); the vault's own config stays local
        if (e.type !== "blob" || e.path.split("/").some((x: string) => x.startsWith("."))) continue;
        const r = await this.pullFile(repo, e.path, e.sha, async () =>
          base64ToArrayBuffer((await this.json(`/repos/${OWNER}/${repo}/git/blobs/${e.sha}`)).content.replace(/\s/g, "")));
        if (r === "conflict") count.conflict.push(e.path); else count[r]++;
      }
      await this.save();
      new Notice(`${repo}: ${count.wrote} updated, ${count.same} unchanged` +
        (count.conflict.length ? `, ${count.conflict.length} kept (edited here): ${count.conflict.slice(0, 5).join(", ")}` : "") +
        (tree.truncated ? ". Repo too large, not every file was listed." : ""), 10000);
    } finally { n.hide(); }
  }

  async pullFile(repo: string, path: string, sha: string, download: () => Promise<ArrayBuffer>) {
    const key = `${repo}/${path}`, vault = this.app.vault, f = vault.getAbstractFileByPath(key);
    if (f instanceof TFile) {
      const local = await gitSha(await vault.readBinary(f));
      if (local === sha) { this.s.base[key] = sha; return "same" as const; }
      if (local !== this.s.base[key]) return "conflict" as const;
      await vault.modifyBinary(f, await download());
    } else if (f) return "conflict" as const; // a folder has that name
    else {
      const dirs = key.split("/").slice(0, -1);
      for (let i = 1; i <= dirs.length; i++) {
        const d = dirs.slice(0, i).join("/");
        if (!vault.getAbstractFileByPath(d)) await vault.createFolder(d);
      }
      await vault.createBinary(key, await download());
    }
    this.s.base[key] = sha;
    return "wrote" as const;
  }

  contents(repo: string, path: string) {
    return `/repos/${OWNER}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  async pull(f: TFile) {
    const w = this.where(f)!;
    const r = await this.gh(`${this.contents(w.repo, w.path)}?ref=${encodeURIComponent(w.branch)}`);
    if (r.status === 404) throw new Error(`${w.path} is not in ${w.repo}`);
    if (r.status >= 400) throw new Error(r.json?.message ?? `HTTP ${r.status}`);
    const res = await this.pullFile(w.repo, w.path, r.json.sha, async () => base64ToArrayBuffer(r.json.content.replace(/\s/g, "")));
    await this.save();
    // ponytail: no merge; a note edited on both sides is kept local and the user resolves it on GitHub
    new Notice(res === "conflict" ? `${f.path} was edited here and on GitHub; kept your version` :
      res === "same" ? `${f.path} is up to date` : `Pulled ${f.path}`);
  }

  // Push with the sha of the last sync: GitHub refuses (409/422) if someone changed the file since.
  async push(f: TFile) {
    const w = this.where(f)!, key = f.path;
    const r = await this.gh(this.contents(w.repo, w.path), "PUT", {
      message: `${this.s.base[key] ? "Update" : "Add"} ${w.path}`,
      content: arrayBufferToBase64(await this.app.vault.readBinary(f)),
      branch: w.branch,
      sha: this.s.base[key],
    });
    if (r.status === 409 || r.status === 422) throw new Error(`${w.path} changed on GitHub since your last pull. Pull first.`);
    if (r.status >= 400) throw new Error(r.json?.message ?? `HTTP ${r.status}`);
    this.s.base[key] = r.json.content.sha;
    await this.save();
    new Notice(`Pushed ${f.path}`);
  }
}

// Git's blob id: sha1("blob <size>\0" + bytes). Lets us compare local files with the repo without downloading.
export async function gitSha(buf: ArrayBuffer) {
  const head = new TextEncoder().encode(`blob ${buf.byteLength}\0`);
  const all = new Uint8Array(head.length + buf.byteLength);
  all.set(head); all.set(new Uint8Array(buf), head.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", all)), (b) => b.toString(16).padStart(2, "0")).join("");
}

class VaultPicker extends SuggestModal<string> {
  constructor(private p: GitHubConnect, private names: string[]) {
    super(p.app);
    this.setPlaceholder(`Pull a ${OWNER} vault into a folder of the same name`);
  }
  getSuggestions(q: string) { return this.names.filter((n) => n.toLowerCase().includes(q.toLowerCase())); }
  renderSuggestion(n: string, el: HTMLElement) { el.setText(this.p.s.vaults[n] ? `${n}  (pulled, update)` : n); }
  onChooseSuggestion(n: string) { this.p.pullVault(n).catch((e) => new Notice(`GitHub: ${e.message}`)); }
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
    new Setting(el).setName("Repository access")
      .setDesc(`The app only reaches ${OWNER} repos it is installed on. Org owners pick them here.`)
      .addButton((b) => b.setButtonText("Manage").onClick(() =>
        window.open(`https://github.com/organizations/${OWNER}/settings/installations`)));
    if (p.token) new Setting(el).setName("Vaults")
      .setDesc(`Pull any ${OWNER} repo you can access into a folder of the same name.`)
      .addButton((b) => b.setButtonText("Pull a vault").onClick(() => p.pickVault()));
  }
}
