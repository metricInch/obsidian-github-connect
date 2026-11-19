# GitHub Connect for Obsidian

Sign in to GitHub without a password or personal token (OAuth device flow via a GitHub App), then push and pull notes to a repository.

## Setup
Built for the **IsometriaInternal** organization. The GitHub App `Obsidian-GitHub-Connect` (client ID `Iv23liN72h2n3K7zuhDS`, public by design) is owned by the org and can only be installed there.

1. An org owner installs the app on the vault repos: Org → Settings → GitHub Apps → Obsidian-GitHub-Connect → Configure → **Only select repositories**.
2. In Obsidian: Settings → GitHub Connect → **Sign in** (enter the code on github.com and approve), then open **GitHub vaults** (ribbon icon or command): every IsometriaInternal repo you can access is listed with its own **Pull** / **Sync** button.

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
`npm i && npm run build`, then copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/github-connect/`.

## Security
- Requires Obsidian 1.11.4+. The GitHub token is kept in Obsidian's secret storage (`app.secretStorage`), not in the vault's `data.json`, so it does not travel with a synced or committed vault.
- The token can only reach repositories where the GitHub App is installed **and** the signed-in user has access, with only the app's permissions (Contents). Revoke it under GitHub → Settings → Applications.
