// Runs main.ts against a stubbed Obsidian + GitHub to check token refresh. `npm test`
import { build } from "esbuild";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { execSync } from "node:child_process";
globalThis.crypto ??= webcrypto;

const stub = `
export class Plugin { constructor(app) { this.app = app } async loadData() { return {} } async saveData() {} }
export class PluginSettingTab {} export class Setting {} export class SuggestModal {}
export class TFile { constructor(path) { this.path = path } } globalThis.TFile = TFile;
export class Notice { hide() {} }
export const arrayBufferToBase64 = () => "", base64ToArrayBuffer = () => new ArrayBuffer(0);
export const requestUrl = (o) => globalThis.github(o);`;
const out = await build({ entryPoints: ["main.ts"], bundle: true, write: false, format: "esm", logLevel: "error",
  plugins: [{ name: "obsidian", setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }));
  } }] });
const { default: GitHubConnect, gitSha } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

function setup(refreshWorks = true) {
  const secrets = new Map();
  const p = new GitHubConnect({ secretStorage: { getSecret: (k) => secrets.get(k) ?? null, setSecret: (k, v) => secrets.set(k, v) } });
  p.s = { login: "me", expires: 0, repo: "r", branch: "main" };
  p.token = "old"; p.refresh = "r1";
  const calls = { refresh: 0 };
  globalThis.github = async ({ url, body, headers }) => {
    if (url.endsWith("/access_token")) {
      calls.refresh++;
      await new Promise((r) => setTimeout(r, 10));
      if (!refreshWorks || !body.includes("refresh_token=r1")) return { status: 200, json: { error: "bad_refresh_token" } };
      return { status: 200, json: { access_token: "new", refresh_token: "r2", expires_in: 28800 } };
    }
    return headers.Authorization === "Bearer new" ? { status: 200, json: { ok: 1 } } : { status: 401, json: {} };
  };
  return { p, calls };
}

{ // expired token: refresh once, retry, rotate refresh token
  const { p, calls } = setup();
  assert.equal((await p.gh("/user")).status, 200);
  assert.deepEqual([p.token, p.refresh, calls.refresh], ["new", "r2", 1]);
  assert.ok(p.s.expires > Date.now());
}
{ // two calls hit 401 together: only one refresh, both succeed
  const { p, calls } = setup();
  const rs = await Promise.all([p.gh("/a"), p.gh("/b")]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200]);
  assert.equal(calls.refresh, 1);
}
{ // refresh rejected: signed out, error says sign in again
  const { p } = setup(false);
  await assert.rejects(p.gh("/user"), /Sign in again/);
  assert.deepEqual([p.token, p.refresh, p.s.login], ["", "", ""]);
}
console.log("ok: refresh, single-flight, sign-out on failed refresh");

{ // vaults: picks the OWNER installation, pages through repositories, sorts
  const { p } = setup();
  p.token = "new";
  const pages = { 1: ["zeta", "alpha"], 2: ["mid"] };
  globalThis.github = async ({ url }) => {
    if (url.includes("/user/installations?")) return { status: 200, json: { installations: [
      { id: 9, account: { login: "someone-else" } }, { id: 7, account: { login: "isometriainternal" } }] } };
    const m = url.match(/installations\/(\d+)\/repositories.*page=(\d+)/);
    assert.equal(m[1], "7");
    return { status: 200, json: { total_count: 3, repositories: (pages[m[2]] ?? []).map((name) => ({ name })) } };
  };
  assert.deepEqual(await p.vaults(), ["alpha", "mid", "zeta"]);
}
console.log("ok: vaults");

{ // gitSha matches `git hash-object`
  const text = "# Note\nhello é\n";
  const want = execSync("git hash-object --stdin", { input: text }).toString().trim();
  assert.equal(await gitSha(new TextEncoder().encode(text).buffer), want);
}
{ // pullFile: new, unchanged, remote-changed, edited-here
  const { p } = setup();
  p.s = { login: "me", expires: 0, vaults: { v: "main" }, base: {} };
  const files = new Map(), folders = new Set();
  const enc = (t) => new TextEncoder().encode(t).buffer, dec = (b) => new TextDecoder().decode(b);
  p.app.vault = {
    getAbstractFileByPath: (k) => files.has(k) ? new TFile(k) : folders.has(k) ? {} : null,
    readBinary: async (f) => files.get(f.path),
    modifyBinary: async (f, b) => files.set(f.path, b),
    createBinary: async (k, b) => files.set(k, b),
    createFolder: async (d) => folders.add(d),
  };
  let downloads = 0;
  const pull = async (text) => p.pullFile("v", "a/n.md", await gitSha(enc(text)), async () => { downloads++; return enc(text); });
  assert.equal(await pull("one"), "wrote");
  assert.ok(folders.has("v") && folders.has("v/a"));
  assert.equal(await pull("one"), "same");
  assert.equal(downloads, 1, "unchanged file is not downloaded");
  assert.equal(await pull("two"), "wrote");
  assert.equal(dec(files.get("v/a/n.md")), "two");
  files.set("v/a/n.md", enc("my edit"));
  assert.equal(await pull("three"), "conflict");
  assert.equal(dec(files.get("v/a/n.md")), "my edit", "local edit kept");

  // push sends the last-synced sha; a 409 becomes "pull first"
  let sent;
  globalThis.github = async ({ body }) => { sent = JSON.parse(body); return { status: 409, json: {} }; };
  p.app.vault.readBinary = async () => enc("my edit");
  await assert.rejects(p.push(new TFile("v/a/n.md")), /Pull first/);
  assert.equal(sent.sha, await gitSha(enc("two")));
  assert.equal(sent.branch, "main");
}
console.log("ok: gitSha, pullFile, push conflict");
