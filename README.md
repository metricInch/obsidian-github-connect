# GitHub Connect for Obsidian

Sign in to GitHub without a password or personal token (OAuth device flow via a GitHub App), then push and pull notes to a repository.

## Setup
Built for the **IsometriaInternal** organization. The GitHub App `Obsidian-GitHub-Connect` (client ID `Iv23liN72h2n3K7zuhDS`, public by design) is owned by the org and can only be installed there.

1. An org owner installs the app on the vault repos: Org → Settings → GitHub Apps → Obsidian-GitHub-Connect → Configure → **Only select repositories**.
2. In Obsidian: Settings → GitHub Connect → **Sign in** (enter the code on github.com and approve), then **Pull a vault**: pick any IsometriaInternal repo the app is installed on that you can access.

Access is the intersection of repos the app is installed on and repos the user can reach. Remove a user from the repo, team or org to cut them off.

## Commands
- **Pull a vault**: pick a repo; all its files land in a vault folder with the repo's name. Run it again to update. Files under dot-folders (`.obsidian`, `.github`) are skipped.
- **Push current note**: send a note inside a pulled folder back to its repo.
- **Pull current note**: update one note from its repo.

Sync never overwrites silently: a pull keeps notes you edited since the last sync (and lists them), and a push is refused if someone changed the file on GitHub since your last pull. No merging yet; resolve on GitHub.

## Install for testing
With [BRAT](https://github.com/TfTHacker/obsidian42-brat): Add beta plugin → `metricInch/obsidian-github-connect`.

## Build
`npm i && npm run build`, then copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/github-connect/`.

## Security
- Requires Obsidian 1.11.4+. The GitHub token is kept in Obsidian's secret storage (`app.secretStorage`), not in the vault's `data.json`, so it does not travel with a synced or committed vault.
- The token can only reach repositories where the GitHub App is installed **and** the signed-in user has access, with only the app's permissions (Contents). Revoke it under GitHub → Settings → Applications.
