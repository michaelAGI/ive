# IVE

IVE (Integrated Vibecoding Environment) keeps parallel coding agents visible
and under control. Run Claude Code, Codex and Gemini CLI sessions side by side,
see what each one is doing, answer their questions and review their changes in
one place. Everything runs on your own machine.

### Chat and Dev

Choose **Chat** for a conversation with Claude or Codex: start from a message,
return to saved chats, answer permission requests and review changes inside the
app. **Dev** adds project navigation, terminal tabs and a grid for parallel
sessions. Switching views keeps the current session and draft, and the sidebar
can be hidden in either view.

Review shows the original request and selected changes. **Explain this** and
**Why another agent?** provide context before you decide whether to launch a
reviewer. [Read about Chat and Dev](CHAT-DEV-INTEGRATION.md).

### Terminals and sessions

Open **New terminal** for a shell tab in your current project, or **New session**
to choose between a terminal and a configured agent session. With no project,
terminals start in your configured start folder. Open tabs stay in the tab bar;
switching tabs preserves each running terminal and its output.

- **Mac app:** `⌘T` opens a terminal tab; `⌘⇧T` opens the agent tree.
- **Mac browser / localhost:** `⌃T` opens an IVE terminal tab (`⌘T` belongs to
  the browser). The **+** button in IVE's tab bar works in both.
- `⌘N` (app) or `⌃N` (Mac browser) opens the terminal/session chooser.

Run the terminal-tab checks with `cd frontend && npm run build && npm run test:terminal-tabs`.

IVE is in beta. Expect rough edges and please open an issue when something breaks.

## Install

### Mac (Apple silicon)

```bash
curl -fsSL https://ive.dev/install.sh | bash
```

This downloads the IVE app from the latest release, checks its SHA-256, lets
macOS verify the signature and notarization, puts the app into Applications
and opens it. Run the same command again to update. You need a Mac with Apple
silicon (M1 or newer), macOS 13.5 or newer and at least one coding CLI you are
signed in to. Python, Node.js and Git are not needed. [Read the script](get.sh)
before you run it.

You can also [download IVE for Mac](https://github.com/michaelAGI/ive/releases/latest/download/IVE-macOS-arm64.dmg)
yourself, open the DMG and drag IVE into Applications. The app is signed by
AIFOREU GmbH and notarized by Apple. It runs its own local service in the
background, so there is no terminal window and no browser tab. Its data lives
in `~/Library/Application Support/com.ive.desktop`, and it listens on
`127.0.0.1:5112` only. The SHA-256 of each DMG is on the
[releases page](https://github.com/michaelAGI/ive/releases).

To uninstall the app, quit it, run
`"/Applications/IVE.app/Contents/Resources/backend/ive-backend" --remove-hooks`
in Terminal and drag IVE to the Trash.

### Linux and Intel Macs (from source)

There is no app for Linux and Intel Macs yet, so the same command builds IVE
from source there:

```bash
curl -fsSL https://ive.dev/install.sh | bash
```

Then start it:

```bash
ive
```

IVE starts in the background and opens in your browser at
`http://127.0.0.1:5111`. You can close the terminal; IVE keeps running until
you run `ive stop`.

If your shell says `command not found`, `~/.local/bin` is not on your `PATH`
yet: run `~/.local/bin/ive`, or add `export PATH="$HOME/.local/bin:$PATH"` to
`~/.zshrc` (the installer prints this line too).

The installer puts IVE into `~/.ive`, installs its Python and npm dependencies
there, builds the app and links the `ive` command into `~/.local/bin`. It does
not use `sudo` and does not start anything.

### Requirements for the source build

- Linux or macOS
- Python 3.11 or newer
- Node.js 22.12 or newer with npm
- Git
- At least one coding CLI you already use and are logged in to:
  [Claude Code](https://code.claude.com), Codex or Gemini CLI

On macOS with Homebrew: `brew install python node git`.

### Install from a clone

```bash
git clone https://github.com/michaelAGI/ive.git
cd ive
bash install.sh
```

On a Mac with Apple silicon, `install.sh` installs the app from the latest
release, exactly like the one-line installer, and opens it. `bin/ive` opens the
app too. Everywhere else `install.sh` builds this checkout; start it with
`bin/ive`. To build from source on an Apple silicon Mac, for example to work on
IVE, run `IVE_INSTALL=source bash install.sh`; `bin/ive` then runs that build
in your browser, and `install.sh` rebuilds it. `IVE_INSTALL=app bash install.sh`
switches the folder back to the app.

A folder that was built from source before the app installer existed keeps its
own projects and history, separate from the app. Running its `ive update` keeps
it a source build. After a manual `git pull`, `bash install.sh`, `bin/ive` and
`bin/ive update` use the app and tell you about the build they leave behind.

`bash install.sh --plan` and `bash start.sh --plan` print every step without
running it. More options are in [INSTALL.md](INSTALL.md).

## Everyday commands

These are for the source build on Linux, Intel Macs and with
`IVE_INSTALL=source`. On a Mac with Apple silicon, IVE is the Mac app, and there
is no `ive` command on your `PATH`. In a clone, `bin/ive` opens the app,
`bin/ive update` updates it and `bin/ive uninstall` removes only the folder.

```bash
ive                 # start IVE in the background and open it in the browser
ive --headless      # start in the background without opening a browser
ive stop            # stop IVE
ive status          # is it running, and where
ive logs            # follow the log (Ctrl+C leaves, IVE keeps running)
ive run             # run IVE in this terminal instead of the background
ive update          # pull the latest version, rebuild and restart a running IVE
ive uninstall       # stop IVE, remove its hooks, the app folder and the ive command
```

`ive` returns once IVE is up. For systemd, launchd or a container, use
`ive run --headless`, which stays in the foreground.

## What IVE changes on your machine

- **Its own folder.** The Mac app keeps its data in
  `~/Library/Application Support/com.ive.desktop`. A source build keeps code,
  dependencies, database and settings in its folder, `~/.ive` with the one-line
  installer (data in `.ive-team-state` there). Nothing is shared with other apps.
- **A local server.** The Mac app listens on `127.0.0.1:5112` only, a source
  build on `127.0.0.1:5111` only. Phone access and other network options are off
  until you turn them on.
- **Hooks in your coding CLIs.** While it runs, IVE adds hooks to
  `~/.claude/settings.json`, `~/.codex/config.toml` and `~/.gemini/settings.json`
  for the CLIs you have installed. They let IVE follow what each agent does and
  let its Safety Gate stop risky commands. Your own hooks stay untouched.
  They stay active, also while IVE is not running, until you remove them:
  `ive uninstall` (or the app's `--remove-hooks`) takes IVE's entries out again.
- **Your shell startup files, only if you turn on the package scanner.** The
  optional AVCP scanner (off by default) adds a marked block to `~/.zshrc` and
  `~/.bashrc` that checks `npm install`, `pip install` and similar commands.
  Turning it off, `ive uninstall` and `--remove-hooks` remove the block.
- **Your existing logins.** Sessions use the login of the CLI you already have.
  You don't need to give IVE an API key to work with your coding CLIs.

## Telemetry

Off by default. If you want to help with anonymous usage numbers, start a source
build with `IVE_TELEMETRY=on ive` (run `ive stop` first if it is already running),
or the quit Mac app with `IVE_TELEMETRY=on /Applications/IVE.app/Contents/MacOS/ive`. It then sends a hashed install ID, the IVE version,
your platform, the number of sessions, uptime and, after a crash, the first
500 characters of the error message to PostHog. No code and no prompts.
[backend/telemetry.py](backend/telemetry.py) shows exactly what is sent.

## Project layout

| Folder | What it is |
| --- | --- |
| `backend/` | Python server (aiohttp), session management, hooks, Safety Gate |
| `frontend/` | React + Vite + xterm.js app |
| `extensions/sandbox/` | Optional sandbox runtime (Docker or Apple container) |
| `deep_research/` | Research and discovery features |
| `anti-vibe-code-pwner/` | Bundled supply-chain scanner (MIT, see its LICENSE) |
| `packaging/` | Scripts for the signed macOS desktop build |
| `e2e/` | End-to-end tests against an isolated backend with fake CLIs |

## Tests

```bash
cd backend && ../.venv/bin/python -m unittest discover -p 'test_*.py'
cd ../frontend && npx playwright install chromium && cd ..
node e2e/run.mjs
```

The e2e suite starts its own backend with a temporary home folder and fake CLIs,
so it never touches your real settings.

## License

[Apache License 2.0](LICENSE). Copyright 2026 AIFOREU GmbH.
Third-party notices are in [NOTICE](NOTICE).
