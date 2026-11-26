// Runs main.ts against a stubbed Obsidian, a fake GitHub API and a local git server. `npm test`
import { build } from "esbuild";
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stub = `
export class Plugin { constructor(app) { this.app = app } async loadData() { return {} } async saveData() {} }
export class PluginSettingTab {} export class Setting {} export class ItemView {}
export class Notice { hide() {} }
export class Modal {} export class Component {} export const MarkdownRenderer = {};
export const normalizePath = (x) => x.split("/").filter(Boolean).join("/") || "/";
// Local git server goes over real HTTP; everything else to the fake GitHub API.
export async function requestUrl(o) {
  if (!o.url.startsWith("http://127.0.0.1")) return globalThis.github(o);
  const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body });
  return { status: r.status, headers: Object.fromEntries(r.headers), arrayBuffer: await r.arrayBuffer() };
}`;
const out = await build({ entryPoints: ["main.ts"], bundle: true, write: false, format: "esm", logLevel: "error",
  plugins: [{ name: "obsidian", setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }));
  } }] });
const { default: GitHubConnect, vaultlessUrl, dropVault, hunks, pick } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

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

{ // conflict picker: keep yours / GitHub's / both per block; an empty side and a block at the very end
  const t = "a\n<<<<<<< Yours\nx\n=======\ny\n>>>>>>> GitHub (last sync by z)\nb\n<<<<<<< Yours\n=======\ngone\n>>>>>>> GitHub (last sync by z)";
  assert.deepEqual(hunks(t).map((h) => [h.ours, h.theirs]), [["x\n", "y\n"], ["", "gone\n"]]);
  assert.equal(pick(t, ["ours", "theirs"]), "a\nx\nb\ngone\n");
  assert.equal(pick(t, ["both", "ours"]), "a\nx\ny\nb\n");
  assert.equal(pick(t, ["theirs", "both"]), "a\ny\nb\ngone\n");
  assert.equal(hunks("no conflict\n").length, 0);
}
console.log("ok: conflict picker");


// ---- git sync, end to end: two devices against a local `git http-backend` ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghc-"));
const sh = (cmd, cwd = tmp) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const srv = path.join(tmp, "srv"), bare = path.join(srv, "IsometriaInternal", "vault1.git");
fs.mkdirSync(path.dirname(bare), { recursive: true });
sh(`git init -q --bare -b main ${bare} && git -C ${bare} config http.receivepack true`);
sh(`git init -q -b main seed && cd seed && git config user.email s@x && git config user.name seed && ` +
   `printf 'one\\ntwo\\nthree\\n' > n1.md && echo a > old.md && echo b > n2.md && mkdir -p sub && echo c > sub/deep.md && ` +
   `git add -A && git commit -qm c1 && echo b2 > n2.md && git commit -qam c2 && echo b3 > n2.md && git commit -qam c3 && ` +
   `git push -q ${bare} main`);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const cgi = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: srv, GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "tester" } });
  req.pipe(cgi.stdin);
  const chunks = [];
  cgi.stdout.on("data", (c) => chunks.push(c));
  cgi.on("close", () => {
    const out = Buffer.concat(chunks), i = out.indexOf("\r\n\r\n");
    const head = out.subarray(0, i).toString().split("\r\n");
    let status = 200;
    for (const line of head) {
      const [k, ...v] = line.split(": ");
      if (k.toLowerCase() === "status") status = parseInt(v.join(": "));
      else res.setHeader(k, v.join(": "));
    }
    res.statusCode = status;
    res.end(out.subarray(i + 4));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

function adapter(root) {
  fs.mkdirSync(root, { recursive: true });
  const P = (x) => path.join(root, x === "/" ? "" : x);
  return {
    exists: async (x) => fs.existsSync(P(x)),
    stat: async (x) => { try { const s = await fsp.stat(P(x)); return { type: s.isDirectory() ? "folder" : "file", ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }; } catch { return null; } },
    list: async (x) => {
      const es = await fsp.readdir(P(x), { withFileTypes: true }), j = (n) => (x === "/" ? n : `${x}/${n}`);
      return { files: es.filter((e) => !e.isDirectory()).map((e) => j(e.name)), folders: es.filter((e) => e.isDirectory()).map((e) => j(e.name)) };
    },
    readBinary: async (x) => { const b = await fsp.readFile(P(x)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    read: async (x) => fsp.readFile(P(x), "utf8"),
    write: async (x, d) => fsp.writeFile(P(x), d),
    writeBinary: async (x, d) => fsp.writeFile(P(x), Buffer.from(d)),
    mkdir: async (x) => fsp.mkdir(P(x)),
    rmdir: async (x, rec) => (rec ? fsp.rm(P(x), { recursive: true }) : fsp.rmdir(P(x))),
    remove: async (x) => fsp.unlink(P(x)),
  };
}
function device(name) {
  const root = path.join(tmp, name), secrets = new Map([["github-connect-token", "t"]]);
  const p = new GitHubConnect({ vault: { adapter: adapter(root) }, secretStorage: { getSecret: (k) => secrets.get(k) ?? null, setSecret: (k, v) => secrets.set(k, v) } });
  p.s = { login: name, id: 1, expires: 0, synced: {}, merging: {} };
  p.base = `http://127.0.0.1:${server.address().port}`;
  const file = (f) => path.join(root, "vault1", f);
  return { p, root, file, read: (f) => fs.readFileSync(file(f), "utf8"), write: (f, t) => fs.writeFileSync(file(f), t),
    sync: () => p.sync("vault1", () => {}) };
}
const A = device("alice"), B = device("bob"), log = () => sh(`git -C ${bare} log --format=%an:%s main`).split("\n");

try {
  // first Pull: shallow clone into vault1/
  const steps = [];
  assert.equal(await A.p.sync("vault1", (t, f) => steps.push([t, f])), "pulled");
  assert.equal(steps[0][0], "Downloading", "bar starts before the download");
  assert.ok(steps.some(([, f]) => f > 0 && f <= 1), "some step reports a percentage");
  assert.ok(steps.every(([, f]) => f === undefined || (f >= 0 && f <= 1)));
  assert.equal(A.read("n2.md"), "b3\n");
  assert.equal(A.read("sub/deep.md"), "c\n");
  assert.ok(fs.existsSync(path.join(A.root, "vault1/.git/shallow")), "clone is shallow");
  assert.equal(sh("git rev-list --count HEAD", path.join(A.root, "vault1")), "1", "only the latest commit downloaded");
  assert.equal(await B.sync(), "pulled");

  // background run(): progress reaches listeners, the job clears itself, errors are kept per vault
  const seen = [];
  const finished = new Promise((r) => A.p.listeners.add((structural) => {
    seen.push([...A.p.jobs.keys()].join());
    if (structural && !A.p.jobs.size) r();
  }));
  A.p.run("vault1");
  A.p.run("vault1"); // second click while running is ignored
  assert.equal(A.p.jobs.size, 1);
  await finished;
  assert.ok(seen.includes("vault1") && !A.p.jobs.size && !A.p.errors.vault1);
  A.p.listeners.clear();

  // Alice edits, adds and deletes, then syncs
  A.write("n1.md", "ONE\ntwo\nthree\n"); A.write("new.md", "hi\n"); fs.unlinkSync(A.file("old.md"));
  assert.equal(await A.sync(), "3 changes sent");
  assert.equal(log()[0], "alice:Obsidian: 3 files by alice");

  // Bob edits another note: his sync merges Alice's changes in and pushes both
  B.write("n2.md", "bob\n");
  assert.equal(await B.sync(), "1 change sent");
  assert.equal(B.read("new.md"), "hi\n");
  assert.ok(!fs.existsSync(B.file("old.md")), "Alice's delete reached Bob");
  assert.equal(B.read("n1.md"), "ONE\ntwo\nthree\n");
  assert.equal(await A.sync(), "up to date");
  assert.equal(A.read("n2.md"), "bob\n", "Bob's edit reached Alice");

  // both edit the same line: Bob gets conflict markers, must fix before Sync goes through
  A.write("n1.md", "ONE\ntwo\nalice\n"); await A.sync();
  B.write("n1.md", "ONE\ntwo\nbob\n");
  await assert.rejects(B.sync(), /edited here and on GitHub: n1.md/);
  assert.equal(B.read("n1.md"), "ONE\ntwo\n<<<<<<< Yours\nbob\n=======\nalice\n>>>>>>> GitHub (last sync by alice)\n");
  assert.deepEqual(hunks(B.read("n1.md")), [{ ours: "bob\n", theirs: "alice\n", label: "GitHub (last sync by alice)" }]);
  await assert.rejects(B.sync(), /still has conflict markers: n1.md/);
  B.write("n1.md", "ONE\ntwo\nalice and bob\n");
  assert.equal(await B.sync(), "1 change sent");
  await A.sync();
  assert.equal(A.read("n1.md"), "ONE\ntwo\nalice and bob\n");
  assert.equal(sh(`git -C ${bare} cat-file -p main`).split("\n").filter((l) => l.startsWith("parent")).length, 2, "merge commit has two parents");

  // a folder that already exists without git (0.4.0 pull) is linked in place, keeping local edits
  const ad = path.join(srv, "IsometriaInternal", "adopt.git");
  sh(`git init -q --bare -b main ${ad} && git -C ${ad} config http.receivepack true`);
  sh(`rm -rf s2 && git init -q -b main s2 && cd s2 && git config user.email s@x && git config user.name seed && ` +
     `echo a > a.md && echo b > b.md && echo same > same.md && echo '*.tmp' > .gitignore && git add -A && git commit -qm c1 && git push -q ${ad} main`);
  const E = device("erin"), hash = (t) => sh(`git hash-object --stdin <<'X'\n${t}X`);
  fs.mkdirSync(path.join(E.root, "adopt"));
  const ef = (f) => path.join(E.root, "adopt", f);
  fs.writeFileSync(ef("a.md"), "a edited\n");   // edited after the 0.4.0 pull
  fs.writeFileSync(ef("b.md"), "b\n");          // untouched
  fs.writeFileSync(ef("same.md"), "same\n");    // untouched, unchanged on GitHub
  fs.writeFileSync(ef("new.md"), "new\n");      // created after the pull
  E.p.s.base = { "adopt/a.md": hash("a\n"), "adopt/b.md": hash("b\n"), "adopt/same.md": hash("same\n") };
  sh(`cd s2 && echo b2 > b.md && git commit -qam c2 && git push -q ${ad} main`); // someone changes b.md on GitHub
  assert.match(await E.p.sync("adopt", () => {}), /linked; 1 note edited here/);
  assert.equal(fs.readFileSync(ef("a.md"), "utf8"), "a edited\n", "local edit kept");
  assert.equal(fs.readFileSync(ef("b.md"), "utf8"), "b2\n", "untouched note updated");
  assert.equal(fs.readFileSync(ef(".gitignore"), "utf8"), "*.tmp\n", "skipped dot file restored");
  assert.equal(fs.readFileSync(ef("new.md"), "utf8"), "new\n");
  assert.equal(await E.p.sync("adopt", () => {}), "2 changes sent");
  assert.equal(sh(`git -C ${ad} show main:a.md`), "a edited");
  assert.equal(sh(`git -C ${ad} show main:new.md`), "new");
  assert.equal(sh(`git -C ${ad} show main:b.md`), "b2", "GitHub's change not reverted");
  assert.equal(sh(`git -C ${ad} rev-list --count main`), "3");

  // interrupted Pull, case 1: only an empty .git on "master" was written (the iPhone report)
  const F = device("frank");
  fs.mkdirSync(path.join(F.root, "vault1"));
  sh(`git init -q -b master ${path.join(F.root, "vault1")}`);
  assert.equal(await F.sync(), "linked");
  assert.equal(F.read("n1.md"), "ONE\ntwo\nalice and bob\n");
  assert.equal(await F.sync(), "up to date");

  // case 2: clone got refs and half the files, app was killed before it finished (synced never set)
  const G = device("gina");
  await G.sync();
  fs.unlinkSync(G.file("n2.md"));                       // never written
  fs.writeFileSync(G.file("n1.md"), "older copy\n");    // our own stale copy
  fs.writeFileSync(G.file("mine.md"), "made by gina\n"); // a note she added meanwhile
  delete G.p.s.synced.vault1;
  const before = sh(`git -C ${bare} rev-parse main`);
  assert.equal(await G.sync(), "linked");
  assert.equal(G.read("n2.md"), "bob\n", "missing file restored, not deleted on GitHub");
  assert.equal(G.read("n1.md"), "ONE\ntwo\nalice and bob\n", "stale copy replaced");
  assert.equal(G.read("mine.md"), "made by gina\n", "her note kept");
  assert.equal(sh(`git -C ${bare} rev-parse main`), before, "nothing pushed while linking");
  assert.equal(await G.sync(), "1 change sent");
  assert.equal(sh(`git -C ${bare} show main:n2.md`), "bob");

  console.log("ok: shallow pull, sync both ways, deletes, conflict + resolve, link existing folder, unfinished pull");

  // empty repo (no commits yet): Pull works, first Sync creates the first commit
  sh(`git init -q --bare -b main ${path.join(srv, "IsometriaInternal", "empty.git")} && git -C ${path.join(srv, "IsometriaInternal", "empty.git")} config http.receivepack true`);
  const D = device("dave");
  assert.equal(await D.p.sync("empty", () => {}), "pulled");
  assert.match(await D.p.sync("empty", () => {}), /empty/);
  fs.writeFileSync(path.join(D.root, "empty", "first.md"), "first\n");
  assert.equal(await D.p.sync("empty", () => {}), "1 change sent");
  assert.equal(sh(`git -C ${path.join(srv, "IsometriaInternal", "empty.git")} show main:first.md`), "first");
  console.log("ok: empty repo");

  // pulled while empty, then the repo was filled elsewhere (a copy pushed to it): Sync brings it in
  const late = path.join(srv, "IsometriaInternal", "late.git");
  sh(`git init -q --bare -b main ${late} && git -C ${late} config http.receivepack true`);
  const H = device("hana");
  assert.equal(await H.p.sync("late", () => {}), "pulled");
  fs.writeFileSync(path.join(H.root, "late", "mine.md"), "hana\n");   // a note made meanwhile
  sh(`rm -rf s3 && git init -q -b main s3 && cd s3 && git config user.email s@x && git config user.name seed && ` +
     `mkdir -p notes && echo brain > notes/a.md && git add -A && git commit -qm c1 && git push -q ${late} main`);
  assert.match(await H.p.sync("late", () => {}), /^linked/);
  assert.equal(fs.readFileSync(path.join(H.root, "late", "notes/a.md"), "utf8"), "brain\n");
  assert.equal(fs.readFileSync(path.join(H.root, "late", "mine.md"), "utf8"), "hana\n", "her note kept");
  assert.equal(await H.p.sync("late", () => {}), "1 change sent");
  assert.equal(sh(`git -C ${late} show main:mine.md`), "hana");
  assert.equal(sh(`git -C ${late} show main:notes/a.md`), "brain");
  console.log("ok: empty repo filled later");

  // AGENTS.md + CLAUDE.md at the vault root: created once, never overwritten
  const C = device("cleo"), am = path.join(C.root, "AGENTS.md"), cm = path.join(C.root, "CLAUDE.md");
  await C.p.claudeMd();
  assert.equal(fs.readFileSync(am, "utf8"), "@VaultGlobals/AGENTS.md\n");
  assert.equal(fs.readFileSync(cm, "utf8"), "@AGENTS.md\n");
  fs.writeFileSync(am, "mine\n"); fs.rmSync(cm);
  await C.p.claudeMd();
  assert.equal(fs.readFileSync(am, "utf8"), "mine\n", "existing AGENTS.md kept");
  assert.equal(fs.readFileSync(cm, "utf8"), "@AGENTS.md\n", "missing CLAUDE.md recreated");
  console.log("ok: AGENTS.md + CLAUDE.md");

  // Shareable link: no vault= (names differ per person), path encoded
  assert.equal(vaultlessUrl("Vault/competitors/hue & co.md"), "obsidian://open?file=Vault%2Fcompetitors%2Fhue%20%26%20co.md");
  // Obsidian's own URL (app.getObsidianUrl, 1.15.1) minus the vault
  assert.equal(dropVault("obsidian://open?vault=Isometria%20Vault&file=Vault%2Fhue"), "obsidian://open?file=Vault%2Fhue");
  assert.equal(dropVault("obsidian://open?file=a&vault=x"), "obsidian://open?file=a");
  assert.equal(dropVault("obsidian://open?file=a"), "obsidian://open?file=a");
  console.log("ok: vault-less link");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
