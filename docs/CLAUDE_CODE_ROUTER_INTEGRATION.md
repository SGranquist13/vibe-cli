# Claude Code Router Integration

This document describes how Vibe integrates with the Claude Code Router to enable routing Claude Code requests to different AI providers and models.

## Overview

The Claude Code Router ([@musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)) is a middleware that sits between Claude Code and AI APIs, allowing you to:

- Route requests to different providers (OpenRouter, DeepSeek, Gemini, etc.)
- Switch between models dynamically in-session using `/model` commands
- Configure different models for different scenarios (default, background, thinking, etc.)
- Maintain a unified Claude Code interface while using various backend models

## Architecture

When Claude Code Router is enabled in Vibe:

```
User Terminal
    ↓
Vibe (Local Mode with Router)
    ↓
Claude Code (with Router Environment)
    ↓
Claude Code Router Service (Port 3456)
    ↓
AI Provider APIs (OpenRouter, etc.)
```

## Installation & Setup

### 1. Install Claude Code Router

```bash
npm install -g @musistudio/claude-code-router
```

### 2. Configure Router

```bash
ccr model
```

This interactive wizard helps you:
- Add AI providers (OpenRouter, etc.)
- Set API keys
- Configure default models
- Set up model routing rules

### 3. Start Router Service

```bash
ccr start
```

The router runs as a background service on port 3456.

### 4. Enable Router in Vibe

```bash
vibe router enable
```

This validates the router installation and configuration, then enables router integration.

## Vibe Router Commands

### Enable Router
```bash
vibe router enable [--config-path <path>]
```

Enables Claude Code Router integration. Validates that:
- `ccr` command is available
- Router service is configured
- Configuration file exists with providers

### Disable Router
```bash
vibe router disable
```

Disables router integration, falling back to direct Claude Code.

### Check Status
```bash
vibe router status
```

Shows current router status, configuration, and any warnings.

### View Configuration
```bash
vibe router config
```

Displays the detailed router configuration from `config.json`.

## How It Works

### Environment Variable Injection

When router is enabled, Vibe automatically sets environment variables that point Claude Code to use the router:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3456
ANTHROPIC_AUTH_TOKEN=test
API_TIMEOUT_MS=600000
NO_PROXY=127.0.0.1
DISABLE_TELEMETRY=true
DISABLE_COST_WARNINGS=true
```

### Local Mode Behavior

- **With Router**: Claude Code runs normally but all API calls go through the router
- **Without Router**: Claude Code uses direct Anthropic API

The local/remote mode toggle is preserved - you can still switch between local interaction and mobile control.

### Model Switching

While in a Claude session, you can switch models dynamically:

```bash
/model openrouter,x-ai/grok-4.1-fast
/model openrouter,anthropic/claude-3.5-sonnet
```

## Configuration File

The router configuration is stored in `~/.claude-code-router/config.json`:

```json
{
  "Providers": [
    {
      "name": "openrouter",
      "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "sk-or-v1-...",
      "models": ["x-ai/grok-4.1-fast"],
      "transformer": { "use": ["openrouter"] }
    }
  ],
  "Router": {
    "default": "openrouter,x-ai/grok-4.1-fast",
    "background": "openrouter,x-ai/grok-4.1-fast",
    "think": "",
    "longContext": "openrouter,x-ai/grok-4.1-fast",
    "longContextThreshold": 60000,
    "webSearch": "openrouter,x-ai/grok-4.1-fast",
    "image": "openrouter,x-ai/grok-4.1-fast"
  }
}
```

## Model Scenarios

The router supports different models for different use cases:

- **`default`**: General coding tasks
- **`background`**: Background processing tasks (cost optimization)
- **`think`**: Reasoning-heavy tasks (Plan Mode)
- **`longContext`**: Tasks with >60K tokens
- **`webSearch`**: Tasks requiring web search capabilities
- **`image`**: Tasks involving image processing

## Troubleshooting

### Router Not Detected
```
✗ Claude Code Router not found
```

**Solution**: Install the router and ensure `ccr` is in your PATH:
```bash
npm install -g @musistudio/claude-code-router
```

### Configuration Issues
```
✗ Router configuration issue: Router config validation failed
```

**Solution**: Run the configuration wizard:
```bash
ccr model
```

### Service Not Running
If Claude Code doesn't use router models, check service status:
```bash
ccr status
ccr start  # If not running
```

### Windows Path Issues
On Windows, the router may be installed in user-specific locations. Vibe automatically detects:
- `C:\nvm4w\nodejs\ccr.ps1`
- `%APPDATA%\npm\ccr.cmd`
- `%LOCALAPPDATA%\pnpm\ccr.cmd`
- Standard PATH locations

## Integration Details

### Detection Logic
Vibe detects router availability by:
1. Checking for `ccr` in PATH
2. Falling back to `npx @musistudio/claude-code-router`
3. Searching Windows-specific install locations
4. Validating configuration file exists and has providers

### Environment Variables
Router integration uses environment variables instead of spawning `ccr code` directly, ensuring:
- Reliable process spawning
- Proper environment inheritance
- Consistent behavior across platforms

### Backward Compatibility
When router is disabled or unavailable, Vibe falls back to direct Claude Code with no behavior changes.

## Examples

### Basic Setup
```bash
# Install and configure
npm install -g @musistudio/claude-code-router
ccr model  # Follow interactive setup
ccr start

# Enable in Vibe
vibe router enable

# Use Vibe normally
vibe
```

### Custom Config Path
```bash
vibe router enable --config-path ~/my-router-config.json
```

### Check Everything is Working
```bash
ccr status           # Router service running
vibe router status   # Vibe integration enabled
vibe                 # Start Claude with router
# In Claude: /model openrouter,x-ai/grok-4.1-fast
```

## Related Documentation

- [Claude Code Router GitHub](https://github.com/musistudio/claude-code-router)
- [Claude Code Integration](./CLAUDE_CODE_INTEGRATION.md)
- [Vibe Quick Start](../../../../QUICK_START.md)
