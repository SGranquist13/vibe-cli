<div align="center">
  <h1>Vibe CLI</h1>
  
  <p><strong>Command-line wrapper for AI coding agents</strong></p>
  
  <p>
    Enables remote control of <strong>Claude Code</strong>, <strong>Codex</strong>, <strong>Gemini CLI</strong>, and <strong>Cursor CLI</strong>
  </p>
</div>

---

## 🚀 Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/SGranquist13/vibe-cli.git
cd vibe-cli

# Install dependencies
yarn install

# Build the project
yarn build

# Link globally (requires npm)
npm link
```

After linking, you can use `vibe` commands from anywhere.

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
| `VIBE_SERVER_URL` | `http://localhost:3005` | Server URL |
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

### Prerequisites

- **Node.js 20+** and npm/yarn
- **Server running locally** (see [server README](../server/README.md))
- **Git** for cloning the repository

### Initial Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/SGranquist13/vibe-cli.git
   cd vibe-cli
   ```

2. **Install dependencies:**
   ```bash
   yarn install
   ```

3. **Build the project:**
   ```bash
   yarn build
   ```

4. **Link globally:**
   ```bash
   npm link
   ```

### Development Workflow

```bash
# Build the project
yarn build

# Development mode (watch for changes)
yarn dev

# Run tests
yarn test

# Type check
yarn typecheck
```

### Local Development Setup

For local development, ensure the server is running:

```bash
# In a separate terminal, start the server
cd ../server
yarn dev
```

Then use the CLI with the local server:

```bash
# Set environment variable (or use default localhost:3005)
export VIBE_SERVER_URL=http://localhost:3005

# Start a session
vibe claude
```

### Project Structure

```
cli/
├── src/
│   ├── claude/      # Claude Code integration
│   ├── codex/        # Codex integration
│   ├── api/          # Server communication
│   ├── commands/     # CLI commands
│   └── utils/        # Utilities
├── docs/             # Integration documentation
└── bin/              # Executable scripts
```

---

## 📖 Documentation

- [**Main Project README**](../README.md) — Full project overview
- [**Quick Start Guide**](../QUICK_START.md) — Complete setup instructions
- [**CLI Development Guide**](CLAUDE.md) — Detailed development docs

### Agent Integration Docs

- [Claude Code Integration](docs/CLAUDE_CODE_INTEGRATION.md)
- [Codex Integration](docs/CODEX_INTEGRATION.md)
- [Gemini Integration](docs/GEMINI_INTEGRATION.md)
- [Cursor Integration](docs/CURSOR_INTEGRATION.md)

### Related Repositories

- [**Mobile App**](https://github.com/SGranquist13/vibe-mobile) — React Native mobile app
- [**Server**](https://github.com/SGranquist13/vibe-server) — Backend server
- [**Main Repository**](https://github.com/SGranquist13/votg) — Meta-repository

---

## 📄 License

MIT License
