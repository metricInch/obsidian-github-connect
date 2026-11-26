# GitHub Connect for Obsidian

## For the team: ready vault (no setup)

Download **[Isometria-Vault.zip](https://github.com/metricInch/obsidian-github-connect/releases/latest/download/Isometria-Vault.zip)**. It has everything already: this plugin, BRAT (keeps it up to date), Homepage and the Minimal theme.

**Computer:** unzip it anywhere outside iCloud/Dropbox → Obsidian → **Open folder as vault** → choose *Isometria Vault* → **Trust author and enable plugins**. The welcome note and the GitHub vaults panel open by themselves: Sign in, then Pull.

**iPhone / iPad:** in the Files app, unzip it and move the *Isometria Vault* folder into **On My iPhone → Obsidian** (not iCloud) → open Obsidian and pick it → **Trust author and enable plugins** → same as above.


Sign in to GitHub without a password or personal token (OAuth device flow via a GitHub App), then push and pull notes to a repository.

## Setup
Built for the **IsometriaInternal** organization. The GitHub App `Obsidian-GitHub-Connect` (client ID `Iv23liN72h2n3K7zuhDS`, public by design) is owned by the org and can only be installed there.

1. An org owner installs the app on the vault repos: Org → Settings → GitHub Apps → Obsidian-GitHub-Connect → Configure → **Only select repositories**.
2. In Obsidian: Settings → GitHub Connect → **Sign in** (enter the code on github.com and approve), then open **GitHub vaults** (ribbon icon or command). It opens in the right sidebar: every IsometriaInternal repo you can access, each with its own **Pull** / **Link** / **Sync** button. Jobs run in the background: close the panel or keep writing; a notice says when each finishes, and the status bar shows progress on desktop.

**Shareable links:** Obsidian's own right-click **Copy Obsidian URL** includes your local vault name, so the link fails for anyone who named theirs differently. The plugin removes the vault name from it (right-click → **Copy path → as Obsidian URL**, the *Copy Obsidian URL for current file* command, tab menus), so the link works for everyone. Turn it off with the *Shareable links* toggle at the bottom of the GitHub vaults panel.

Access is the intersection of repos the app is installed on and repos the user can reach. Remove a user from the repo, team or org to cut them off.

## How sync works
Real git in the plugin ([isomorphic-git](https://isomorphic-git.org)), no git install needed, same code on desktop and mobile.

- **Pull** (first time): shallow clone, only the latest commit, into a vault folder named after the repo. Each folder is its own git repo and syncs on its own.
- **Sync**: commit everything changed in that folder (edits, new and deleted notes) as one commit, fetch only the new commits, merge, push.
- **Conflicts**: if a note was edited here and on GitHub, Sync stops and leaves `<<<<<<<` / `>>>>>>>` markers in it. Fix the note, Sync again; that makes the merge commit. Sync refuses while markers remain.
- A folder that already exists without git (pulled by 0.4.0, or made by hand) shows **Link**: it becomes a git repo in place. Notes edited since the 0.4.0 pull and new notes are kept and sent on the next Sync; untouched notes get GitHub's latest version.
- Empty repos work: Pull, add notes, Sync makes the first commit on `main`.

## Install for testing
With [BRAT](https://github.com/TfTHacker/obsidian42-brat): Add beta plugin → `metricInch/obsidian-github-connect`.

## Build
`npm run starter` builds `dist/Isometria-Vault.zip` (pinned upstream plugin versions).

**Release:** bump `version` in `manifest.json` and `package.json` and merge to `main`. The `release` workflow builds, tests and publishes that version with `main.js`, `manifest.json` and `Isometria-Vault.zip`; a version that already has a release is skipped.

`npm i && npm run build`, then copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/github-connect/`.

## Security
- Requires Obsidian 1.11.4+. The GitHub token is kept in Obsidian's secret storage (`app.secretStorage`), not in the vault's `data.json`, so it does not travel with a synced or committed vault.
- The token can only reach repositories where the GitHub App is installed **and** the signed-in user has access, with only the app's permissions (Contents). Revoke it under GitHub → Settings → Applications.
