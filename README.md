# GitHub Connect for Obsidian

Sign in to GitHub without a password or personal token (OAuth device flow via a GitHub App), then push and pull notes to a repository.

## Setup
1. Create a GitHub App: Settings → Developer settings → GitHub Apps → New. Enable **Device Flow**, turn off the webhook, give Repository permissions → **Contents: Read & write**, and uncheck "Expire user authorization tokens". Copy the Client ID.
2. Install the app on the repo you sync to.
3. In Obsidian: Settings → GitHub Connect → paste the Client ID, set owner/repo/branch, click **Sign in**.

## Commands
- **Push current note**: create or update the note at the same path in the repo.
- **Pull current note**: overwrite the local note with the repo version (no merge).

## Install for testing
With [BRAT](https://github.com/TfTHacker/obsidian42-brat): Add beta plugin → `metricInch/obsidian-github-connect`.

## Build
`npm i && npm run build`, then copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/github-connect/`.
