# p-spore

A Linux-first, local-first AI agent you run from your own terminal. `p-spore` keeps a
long-running local daemon that holds your sessions, memory, scheduled jobs and child
agents, and gives you a reconnecting TUI on top of it. Everything lives on your machine
under `~/.pspore` — there is no hosted backend and no account.

Built on [Pi](https://github.com/earendil-works/pi) (pinned to `v0.84.1`).

## Requirements

- Linux
- Node.js 24 (`>=24.0.0 <25`)
- systemd user services (`systemctl --user`)

## Install

```bash
npm install --global p-spore
p-spore tui
```

This installs two equivalent commands, `p-spore` and the shorter `pspore` — both start the
same CLI, so use whichever you prefer. To run it once without installing:

```bash
npx p-spore --help
```

`p-spore tui` initializes a missing home directory and automatically installs, enables,
and starts the per-user `pSpore` system service. The TUI and desktop app are reconnecting
shells only: closing either client leaves sessions, scheduled jobs, MCP connections and
other background work running. pSpore also attempts to enable user lingering so the
service can start at boot without waiting for an interactive login.

## Configure a model

No model is configured out of the box. The daemon still starts so you can check its
health, and the first prompt returns `model_not_configured` until you set one up.

```bash
p-spore config show
p-spore config set deepseek deepseek-v4-flash off
p-spore config set openai gpt-5.6-terra low
p-spore config set custom-openai my-model https://gateway.example.com/v1 responses off
p-spore config key                 # hidden TTY input, or piped from stdin
p-spore config cookie              # optional Cookie header for an LLM proxy
p-spore config clear-key
p-spore config clear-cookie
```

Three provider kinds are supported: `deepseek`, `openai`, and `custom-openai` for any
OpenAI-compatible endpoint (choose `chat` or `responses` compatibility). API keys and
optional proxy cookies are written to `~/.pspore/credentials/<provider>.api-key` and
`<provider>.cookie` with mode `0600` and are never stored in `config.json`, sessions, or
logs. The cookie is sent as an HTTP `Cookie` header when the model runtime calls the
proxy. You can also supply credentials through the daemon's environment instead.

## Approvals

Tool calls are gated by a single daemon-wide policy. The default `ask_risky` only stops on
risky operations; `ask_all` confirms every mutating tool; `deny` refuses all of them.

```bash
p-spore config permissions ask_risky      # default
p-spore config permissions ask_all
p-spore config permissions bypass         # alias for allow_all
p-spore config permissions deny
```

`allow_all` (`bypass`) skips every approval prompt: reads, writes, shell commands, `sudo`
and MCP calls all run immediately with the privileges of the user running the daemon.
pSpore is not a sandbox, so only bypass approvals for work you already trust. The same
setting is available as `/config permissions ...` in the TUI and under **Settings →
权限** in the desktop client. Restart the daemon to apply a change to a running one.

## Everyday commands

```bash
p-spore init                       # create config/workspace/state directories
p-spore doctor                     # check Node, config, model, shell, ripgrep, MCP, daemon
p-spore status                     # daemon and session status
p-spore tui                        # reconnecting terminal client
p-spore prompt "summarize today's notes"
p-spore service status             # system service and boot state
p-spore service logs               # recent service journal
p-spore service restart            # restart the background service
p-spore daemon                     # foreground service process (diagnostics/systemd)
```

Add `--home PATH` to any command, or set `PSPORE_HOME`, to work against a home other than
the default `~/.pspore`. Run `p-spore help` for the full command list.

### Scheduled jobs

Define a five-field cron job in `workspace/jobs/<job-id>.json`, or create and update one
atomically from a file. Runs are recorded in a durable ledger and can be triggered or
cancelled by hand.

```bash
p-spore schedule put job.json
p-spore jobs
p-spore run <job-id>
p-spore runs
p-spore cancel <run-id>
p-spore notifications
```

### Child agents

Spawn bounded child agents that share read access, exchange messages with them while they
work, and wait on or cancel them.

```bash
p-spore agent spawn "inspect the workspace API"
p-spore agent send <agent-id> "focus on error handling"
p-spore agents
p-spore agent join <agent-id>
p-spore agent cancel <agent-id>
```

### MCP servers

MCP servers are declared in `config.json` and reference secrets indirectly through
`envRefs`/`headerRefs`. Only `trusted-local` servers are started, and only on demand.

```bash
p-spore mcp list                   # configured servers and health, without connecting
p-spore mcp discover <server-id>   # connect and activate one trusted server
p-spore mcp tools                  # schemas active in this daemon process
p-spore mcp ping <server-id>
```

### Skills and plugins

Skills and host plugins can execute arbitrary code, so they are only loaded after you
explicitly trust them. Staged content is inspected first — schema, paths, dependencies and
syntax only, never imported — and installing requires echoing back the exact SHA-256 you
were just shown.

```bash
p-spore resource inspect <staging-path>
p-spore resource install <staging-path> <sha256>
p-spore resources
p-spore resource disable <skill|host-plugin> <name> <sha256>
```

## Security model

- Single user, local-first. Nothing is exposed to the network; clients talk to the daemon
  over a Unix domain socket.
- Tools run as the user who started `p-spore`. This is **not** a sandbox.
- `allow_all` lets the model run any tool action as that user, which can reach root if you
  have passwordless or cached `sudo`.
- Skills, Pi extensions, plugins and local MCP servers are loaded only after explicit trust.

## Desktop client

This npm package is the CLI and does not bundle Electron. `p-spore desktop` works when
Electron is available in a source checkout; otherwise download the desktop zip from the
project's GitHub Releases. The full zip includes Chromium and a clickable
`创建桌面快捷方式.sh`. Later upgrades can use the smaller overlay zip, which replaces
only `resources/app.asar` and does not include Chromium. The desktop app automatically
registers the same systemd user service and never ties the service lifetime to a window.

## Links

- [Repository](https://github.com/advnljs/pSpore)
- [Issues](https://github.com/advnljs/pSpore/issues)
- Project overview and development notes (Chinese): `docs/project-overview.md`
