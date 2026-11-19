import {
  App, Notice, Plugin, PluginSettingTab, Setting, TFile,
  arrayBufferToBase64, base64ToArrayBuffer, requestUrl,
} from "obsidian";

interface Settings { clientId: string; login: string; owner: string; repo: string; branch: string }
const DEFAULTS: Settings = { clientId: "", login: "", owner: "", repo: "", branch: "main" };
const SECRET = "github-connect-token";
const FORM = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };

export default class GitHubConnect extends Plugin {
  s: Settings = { ...DEFAULTS };

  // Token lives in Obsidian's secret storage, not in the vault's data.json.
  get token() { return this.app.secretStorage.getSecret(SECRET) ?? ""; }
  set token(v: string) { this.app.secretStorage.setSecret(SECRET, v); }

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
    if (!this.s.clientId) return new Notice("Set the GitHub App client ID in settings first");
    const d = (await requestUrl({ url: "https://github.com/login/device/code", method: "POST", throw: false,
      headers: FORM, body: `client_id=${this.s.clientId}` })).json;
    if (!d.device_code) return new Notice(`GitHub: ${d.error_description ?? d.error ?? "check the client ID and that Device Flow is enabled"}`);
    await navigator.clipboard.writeText(d.user_code);
    const n = new Notice(`Code ${d.user_code} copied. Paste it on the GitHub page.`, 0);
    window.open(d.verification_uri);

    let wait: number = d.interval;
    const deadline = Date.now() + d.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep(wait * 1000);
      const t = (await requestUrl({ url: "https://github.com/login/oauth/access_token", method: "POST", throw: false, headers: FORM,
        body: `client_id=${this.s.clientId}&device_code=${d.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code` })).json;
      if (t.access_token) {
        this.token = t.access_token;
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

  async gh(path: string, method = "GET", body?: object) {
    const r = await requestUrl({ url: `https://api.github.com${path}`, method, throw: false,
      body: body && JSON.stringify(body),
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json" } });
    if (r.status === 401) { this.token = ""; await this.save(); throw new Error("session expired, run Sign in again"); }
    return r;
  }

  contentsUrl(f: TFile) {
    if (!this.token) throw new Error("not signed in");
    if (!this.s.owner || !this.s.repo) throw new Error("set owner and repo in settings");
    const p = f.path.split("/").map(encodeURIComponent).join("/");
    return `/repos/${this.s.owner}/${this.s.repo}/contents/${p}`;
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
        if (p.token) { p.token = p.s.login = ""; await p.save(); } else await p.signIn();
        this.display();
      }));
    const text = (name: string, key: "clientId" | "owner" | "repo" | "branch", desc = "") =>
      new Setting(el).setName(name).setDesc(desc).addText((t) =>
        t.setValue(p.s[key]).onChange(async (v) => { p.s[key] = v.trim(); await p.save(); }));
    text("GitHub App client ID", "clientId", "From your GitHub App page (Device Flow enabled).");
    text("Owner", "owner");
    text("Repository", "repo");
    text("Branch", "branch");
  }
}
