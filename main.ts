import {
  App, Notice, Plugin, PluginSettingTab, Setting, TFile,
  RequestUrlResponse, arrayBufferToBase64, base64ToArrayBuffer, requestUrl,
} from "obsidian";

interface Settings { login: string; expires: number; repo: string; branch: string }
const DEFAULTS: Settings = { login: "", expires: 0, repo: "", branch: "main" };
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
    this.s = { ...DEFAULTS, ...d };
    await this.save();
    this.addSettingTab(new Tab(this.app, this));
    this.addCommand({ id: "sign-in", name: "Sign in", callback: () => this.signIn().catch((e) => new Notice(`GitHub: ${e.message}`)) });
    this.addCommand({ id: "push-note", name: "Push current note", checkCallback: (c) => this.onNote(c, (f) => this.push(f)) });
    this.addCommand({ id: "pull-note", name: "Pull current note", checkCallback: (c) => this.onNote(c, (f) => this.pull(f)) });
  }

  save() { return this.saveData(this.s); }

  onNote(checking: boolean, fn: (f: TFile) => Promise<void>) {
    const f = this.app.workspace.getActiveFile();
    if (!f) return false;
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

  contentsUrl(f: TFile) {
    if (!this.token) throw new Error("not signed in");
    if (!this.s.repo) throw new Error("choose a vault in settings");
    const p = f.path.split("/").map(encodeURIComponent).join("/");
    return `/repos/${OWNER}/${this.s.repo}/contents/${p}`;
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

  async remote(f: TFile) {
    const r = await this.gh(`${this.contentsUrl(f)}?ref=${encodeURIComponent(this.s.branch)}`);
    if (r.status === 404) return null;
    if (r.status >= 400) throw new Error(r.json?.message ?? `HTTP ${r.status}`);
    return r.json as { sha: string; content: string };
  }

  async push(f: TFile) {
    const old = await this.remote(f);
    const r = await this.gh(this.contentsUrl(f), "PUT", {
      message: `${old ? "Update" : "Add"} ${f.path}`,
      content: arrayBufferToBase64(await this.app.vault.readBinary(f)),
      branch: this.s.branch,
      sha: old?.sha,
    });
    if (r.status >= 400) throw new Error(r.json?.message ?? `HTTP ${r.status}`);
    new Notice(`Pushed ${f.path}`);
  }

  async pull(f: TFile) {
    const rem = await this.remote(f);
    if (!rem) throw new Error(`${f.path} is not in ${this.s.repo}`);
    // ponytail: overwrites the local note, no merge; add a diff/confirm step if users edit both sides
    await this.app.vault.modifyBinary(f, base64ToArrayBuffer(rem.content.replace(/\s/g, "")));
    new Notice(`Pulled ${f.path}`);
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
    new Setting(el).setName("Repository access")
      .setDesc(`The app only reaches ${OWNER} repos it is installed on. Org owners pick them here.`)
      .addButton((b) => b.setButtonText("Manage").onClick(() =>
        window.open(`https://github.com/organizations/${OWNER}/settings/installations`)));
    if (p.token) new Setting(el).setName("Vault").setDesc(`${OWNER} repos you can open with this app.`)
      .addDropdown((d) => {
        d.addOption("", "Loading…");
        d.onChange(async (v) => { p.s.repo = v; await p.save(); });
        p.vaults().then((names) => {
          d.selectEl.empty();
          d.addOption("", names.length ? "Choose a vault" : "None: ask an org owner to add the app to a repo");
          names.forEach((n) => d.addOption(n, n));
          d.setValue(names.includes(p.s.repo) ? p.s.repo : "");
        }, (e) => { d.selectEl.empty(); d.addOption("", `Could not load vaults: ${e.message}`); });
      })
      .addExtraButton((b) => b.setIcon("refresh-cw").setTooltip("Reload").onClick(() => this.display()));
    new Setting(el).setName("Branch").addText((t) =>
      t.setValue(p.s.branch).onChange(async (v) => { p.s.branch = v.trim(); await p.save(); }));
  }
}
