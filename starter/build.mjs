// Builds dist/Isometria-Vault.zip: a ready vault with GitHub Connect, BRAT (keeps it updated),
// Homepage (opens Home.md) and the Minimal theme. Pinned upstream versions. `npm run starter`
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PLUGINS = {
  homepage: ["mirnovov/obsidian-homepage", "4.6.0"],
  "obsidian42-brat": ["TfTHacker/obsidian42-brat", "2.2.0"],
};
const THEME = ["kepano/obsidian-minimal", "9.1.4"];
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), dist = path.join(root, "dist");
const vault = path.join(dist, "Isometria Vault"), cfg = path.join(vault, ".obsidian");
fs.rmSync(dist, { recursive: true, force: true });

async function asset(repo, tag, name) {
  const r = await fetch(`https://github.com/${repo}/releases/download/${tag}/${name}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${repo}@${tag}/${name}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
function put(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
const json = (v) => JSON.stringify(v, null, 2) + "\n";

for (const [id, [repo, tag]] of Object.entries(PLUGINS)) {
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    const b = await asset(repo, tag, name);
    if (!b && name !== "styles.css") throw new Error(`${repo}@${tag} has no ${name}`);
    if (b) put(path.join(cfg, "plugins", id, name), b);
  }
  const m = JSON.parse(fs.readFileSync(path.join(cfg, "plugins", id, "manifest.json"), "utf8"));
  if (m.id !== id) throw new Error(`${repo}: manifest id is ${m.id}, expected ${id}`);
}
for (const name of ["main.js", "manifest.json"]) put(path.join(cfg, "plugins", "github-connect", name), fs.readFileSync(path.join(root, name)));

const themeManifest = await asset(THEME[0], THEME[1], "manifest.json");
const themeName = JSON.parse(themeManifest).name;
put(path.join(cfg, "themes", themeName, "manifest.json"), themeManifest);
put(path.join(cfg, "themes", themeName, "theme.css"), await asset(THEME[0], THEME[1], "theme.css"));

put(path.join(cfg, "community-plugins.json"), json(["github-connect", "homepage", "obsidian42-brat"]));
put(path.join(cfg, "appearance.json"), json({ cssTheme: themeName }));
// BRAT updates GitHub Connect from its GitHub releases at every start.
put(path.join(cfg, "plugins", "obsidian42-brat", "data.json"), json({ pluginList: ["metricInch/obsidian-github-connect"], updateAtStartup: true }));
put(path.join(vault, "Home.md"), fs.readFileSync(path.join(root, "starter", "Home.md")));

// Every enabled plugin is in the vault, under the id its manifest declares.
for (const id of JSON.parse(fs.readFileSync(path.join(cfg, "community-plugins.json"), "utf8"))) {
  const m = JSON.parse(fs.readFileSync(path.join(cfg, "plugins", id, "manifest.json"), "utf8"));
  if (m.id !== id || !fs.existsSync(path.join(cfg, "plugins", id, "main.js"))) throw new Error(`plugin ${id} incomplete`);
}
execFileSync("zip", ["-qr", "Isometria-Vault.zip", "Isometria Vault"], { cwd: dist });
console.log(`dist/Isometria-Vault.zip  theme=${themeName}  plugins=${Object.keys(PLUGINS).join(",")},github-connect`);
