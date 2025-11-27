<div align="center">
  <h1>Vibe CLI</h1>
  
  <p><strong>Command-line wrapper for AI coding agents</strong></p>
  
  <p>
    Enables remote control of <strong>Claude Code</strong>, <strong>Codex</strong>, <strong>Gemini CLI</strong>, and <strong>Cursor CLI</strong>
  </p>
</div>

---

## 🚀 Installation

### From npm (Recommended)

```bash
npm install -g vibe-cli
```

### From Source

```bash
cd cli
yarn install
yarn build
npm link
```

---

## ✨ Usage

### Start a Session

```bash
# Claude Code
vibe claude

# Codex
vibe codex

# Gemini CLI
vibe gemini

# Cursor CLI
vibe cursor
```

### Session Options

```bash
vibe claude --resume     # Resume previous session
```

### Authentication

```bash
vibe auth login          # Link to mobile app (generates QR code)
vibe auth logout         # Log out
vibe auth status         # Check auth status
```

### Daemon Mode

Start sessions remotely from the mobile app:

```bash
vibe daemon start        # Start background daemon
vibe daemon stop         # Stop daemon
vibe daemon status       # Check status
vibe daemon list         # List active sessions
```

### Diagnostics

```bash
vibe doctor              # System health check
vibe doctor clean        # Cleanup stale processes
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBE_SERVER_URL` | `https://vibe.whisk.dev` | Server URL |
| `VIBE_HOME_DIR` | `~/.vibe` | Config directory |
| `VIBE_EXPERIMENTAL` | - | Enable experimental features |
| `VIBE_DISABLE_CAFFEINATE` | - | Disable macOS caffeinate |
| `GEMINI_CLIENT_ID` | - | Google OAuth client ID for Gemini authentication |
| `GEMINI_CLIENT_SECRET` | - | Google OAuth client secret for Gemini authentication |

### Local Development

```bash
# Use local server
export VIBE_SERVER_URL=http://localhost:3005
vibe claude
```

---

## 🏗️ Architecture

```
vibe claude
    │
    ├── Creates encrypted session
    ├── Connects to server via WebSocket
    ├── Spawns Claude Code
    │
    └── Syncs messages to mobile app
```

**Supported Agents:**

| Agent | Integration Method |
|-------|-------------------|
| Claude Code | Claude Code SDK + file watching |
| Codex | MCP (Model Context Protocol) |
| Gemini CLI | Process spawning |
| Cursor CLI | Process spawning |

---

## 🛠️ Development

```bash
# Build
yarn build

# Development mode
yarn dev

# Run tests
yarn test

# Type check
yarn typecheck
```

---

## 📖 Documentation

- [**Main README**](../README.md) — Full project overview
- [**Quick Start**](../QUICK_START.md) — Complete setup guide
- [**CLI Development Guide**](CLAUDE.md) — Detailed development docs

### Agent Integration Docs

- [Claude Code Integration](docs/CLAUDE_CODE_INTEGRATION.md)
- [Codex Integration](docs/CODEX_INTEGRATION.md)
- [Gemini Integration](docs/GEMINI_INTEGRATION.md)
- [Cursor Integration](docs/CURSOR_INTEGRATION.md)

---

## 📄 License

MIT License
