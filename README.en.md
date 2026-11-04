<p align="center"><a href="README.md">Português</a> · <strong>English</strong></p>

<p align="center">
  <img src="docs/brand/readme-hero.en.png" alt="Stream P2P: your screen, everyone at the same time" width="100%">
</p>

<p align="center">
  <a href="https://github.com/yagoriccomi/stream-p2p/releases/latest"><img src="https://img.shields.io/github/v/release/yagoriccomi/stream-p2p?color=7f00ff&label=release" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/yagoriccomi/stream-p2p?color=1f6feb&label=license" alt="License"></a>
  <img src="https://img.shields.io/badge/tests-node%20--test-1a7f37" alt="Tests with node --test">
  <img src="https://img.shields.io/badge/Node-24-1a7f37?logo=nodedotjs&logoColor=white" alt="Node 24">
  <img src="https://img.shields.io/badge/Windows-Tauri%202-0969da?logo=tauri&logoColor=white" alt="Windows app with Tauri 2">
  <img src="https://img.shields.io/badge/Discord-%2Fstream-5865f2?logo=discord&logoColor=white" alt="Discord bot">
</p>

<p align="center">
  <a href="https://stream.yagoriccomi.com.br"><img src="https://img.shields.io/badge/Open_in_the_browser-7f00ff?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Open in the browser"></a>
  <a href="https://github.com/yagoriccomi/stream-p2p/releases/latest"><img src="https://img.shields.io/badge/Download_for_Windows-1c1c20?style=for-the-badge&logo=github&logoColor=white" alt="Download for Windows"></a>
  <a href="https://stream.yagoriccomi.com.br/discord/install"><img src="https://img.shields.io/badge/Add_the_bot_to_Discord-1c1c20?style=for-the-badge&logo=discord&logoColor=white" alt="Add the bot to Discord"></a>
</p>

<p align="center">
  One person shares, everyone else watches and talks over voice.<br>
  It runs in the browser, on your phone as an app, and on Windows with its own app.<br>
  Nobody signs up: pick a nickname and send the link. The interface is in Portuguese.
</p>

## What's good about it

<img src="docs/brand/readme-features.en.png" alt="No sign-up. Same delay for everyone, from 60 to 400 ms. Real-time voice. Up to 50 people, with video flowing down a tree and up to 1440p60. Windows app with a choice of which apps go into the audio. Discord bot with /stream criar." width="100%">

## How it works

<img src="docs/brand/readme-how.en.png" alt="The server only does signaling. Whoever is sharing sends video to relays, which send it to the people watching. Voice is a mesh; without a direct link, media goes through TURN." width="100%">

## Use it now

1. Open [stream.yagoriccomi.com.br](https://stream.yagoriccomi.com.br), type a nickname and click **Criar sessão** (create session).
2. Send the invite link to your friends.
3. Click **Transmitir** (share), pick the screen and the quality. Anyone who wants a turn clicks **Pedir a vez** (ask for a turn).

On a phone you can watch and talk: on Android, **Install app**; on iPhone, **Share › Add to Home Screen**.

## Installing the Windows app

The installer is not code-signed yet, so Windows shows a warning the first time. Click **More info**, then **Run anyway**. It installs for your user only, without asking for administrator rights.

<img src="docs/brand/smartscreen.en.png" alt="Step 1: click More info. Step 2: click Run anyway." width="100%">

## On Discord

| Command | What it does |
|---|---|
| `/stream criar` | Opens a session and posts the Join button |
| `/stream status` | Who is in each session and who is sharing |
| `/stream convite` | Posts the last session's button again |
| `/stream encerrar` | Ends the last session you created there |
| `/stream app` | Link to download the Windows app |
| `/stream help` | Explains the features and gives tips |
| Right-click › Apps › **Chamar para stream** | Calls the person and sends them the link by DM |

## Run it locally

```bash
npm install
npm test     # sessions, permissions, turn queue, tree, Discord bot
npm start    # http://localhost:3000
```

```text
server/   signaling, sessions, video tree, Discord bot
web/      the site (also a PWA on phones)
app/      Windows app (Tauri 2, Rust)
worker/   the bot's front door (Cloudflare Worker)
e2e/      browser tests with a simulated network
docs/     technical docs, plans, delivery notes and brand
```

Testing and deploying the server, the app and the bot: [technical docs](docs/TECNICO.md) (in Portuguese).

<details>
<summary><strong>Known limitations</strong></summary>

State lives in memory (restarting the server ends the sessions), relays re-encode in the browser, and there is no native NVENC/AMF encoder yet. The full list is under [Limitações](docs/TECNICO.md#limitações) (in Portuguese).

</details>

---

<p align="center">Made by <a href="https://github.com/yagoriccomi">Yago Riccomi</a> · <a href="LICENSE">GPL-3.0</a> license</p>
