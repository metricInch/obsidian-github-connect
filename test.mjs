// Runs main.ts against a stubbed Obsidian + GitHub to check token refresh. `npm test`
import { build } from "esbuild";
import assert from "node:assert/strict";

const stub = `
export class Plugin { constructor(app) { this.app = app } async loadData() { return {} } async saveData() {} }
export class PluginSettingTab {} export class Setting {} export class TFile {}
export class Notice { hide() {} }
export const arrayBufferToBase64 = () => "", base64ToArrayBuffer = () => new ArrayBuffer(0);
export const requestUrl = (o) => globalThis.github(o);`;
const out = await build({ entryPoints: ["main.ts"], bundle: true, write: false, format: "esm", logLevel: "error",
  plugins: [{ name: "obsidian", setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }));
  } }] });
const { default: GitHubConnect } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

function setup(refreshWorks = true) {
  const secrets = new Map();
  const p = new GitHubConnect({ secretStorage: { getSecret: (k) => secrets.get(k) ?? null, setSecret: (k, v) => secrets.set(k, v) } });
  p.s = { clientId: "Iv23test", login: "me", expires: 0, owner: "o", repo: "r", branch: "main" };
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
