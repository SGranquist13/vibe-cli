# Gemini CLI Integration Documentation

## Introduction

This document explains how Vibe-on-the-Go integrates with Gemini CLI, covering the architecture, message flow, integration method, and extensibility patterns. This serves as a reference for understanding the current implementation and for tracking the remaining gaps.

**⚠️ Status: Experimental — the process-based client is wired end-to-end, but resume support and richer permission enforcement still need work.**

## Architecture Overview

Vibe-on-the-Go integrates with Gemini CLI through a **process-based system today**, with MCP or HTTP transports kept in mind for future iterations.

### High-Level Architecture

```
┌─────────────────┐
│   User Input    │ (Terminal or Mobile)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Message Queue  │ (MessageQueue2)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ GeminiClient    │ (Gemini CLI Client)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Gemini CLI     │ (Process or MCP)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Events/Messages│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Encryption &   │
│  WebSocket      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     Server      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Mobile App     │
└─────────────────┘
```

## Integration Method

### Current approach: process spawning

The Gemini integration currently spawns the official `gemini` CLI with `--output-format stream-json`, mirroring the Claude process bridge. `GeminiClient` owns the child process, parses JSON lines from stdout, and forwards structured events back to the session. You can override the executable path with `VIBE_GEMINI_BIN` to support custom installs or the automated smoke tests.

Other transports (MCP/stdin or HTTP) are still possible future enhancements, but the process-based flow is the one that ships today.

## Key Components

### 1. `runGemini.ts` - Main Entry Point

**Location**: [`cli/src/gemini/runGemini.ts`](cli/src/gemini/runGemini.ts)

This is the main entry point for Gemini CLI sessions. It handles:

- Session creation and initialization
- Message queue setup
- Gemini client connection
- Message processing and routing
- Permission handling
- Cleanup and lifecycle management

**Key Responsibilities:**

```typescript
export async function runGemini(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void>
```

The implementation follows the same pattern as `runCodex.ts` but maintains complete separation.

### 2. `geminiClient.ts` - Gemini Client Implementation

**Location**: [`cli/src/gemini/geminiClient.ts`](cli/src/gemini/geminiClient.ts)

Wraps communication with the Gemini CLI process.

**Key Behaviors:**
- Resolves the CLI binary (including `VIBE_GEMINI_BIN` overrides) and spawns it via `cross-spawn`.
- Forces `--output-format stream-json` in non-interactive mode so that mobile/daemon sessions stay in sync.
- Streams stdout line-by-line, parses JSON payloads, and pushes them through the handler registered by `runGemini.ts`.
- Caches the last session config (cwd/model) so `continueSession()` reuses the same environment when spawning follow-up prompts.
- Provides a hook for future resume support (`storeSessionForResume`) and abort handling via the injected `AbortSignal`.

#### Windows spawning & troubleshooting

- `GeminiClient` resolves the executable by running both `where` and `where.exe` plus `npm config get prefix` / `npm bin -g`, so standard installs such as `C:\Users\you\AppData\Roaming\npm\gemini.cmd` are detected automatically.
- The CLI launches Gemini with [`cross-spawn`](https://github.com/moxystudio/node-cross-spawn), which prevents the `spawn EINVAL` failures that occur when Windows sessions inherit stdio across different terminals.
- Set `DEBUG=1` (PowerShell: `setx DEBUG 1` or `set DEBUG=1 && vibe gemini`) before starting a session to log the resolved Gemini path, arguments, cwd, and stdio mode; the same diagnostics also show up when the mobile app sends prompts.
- If the CLI still cannot be located, run `where gemini` manually and add the reported directory to your `PATH`, or reinstall via `npm install -g @google/gemini-cli`.
- Gemini CLI versions ≥0.0.21 removed the `--mcp-config` flag. If you need MCP access, run `gemini mcp add ...` ahead of time—the CLI will warn when our session detects an MCP config but cannot inject it automatically.
- Remote sessions now always run Gemini in `--output-format stream-json` mode so that mobile prompts and responses stay in sync. If you explicitly want to interact with the Gemini prompt in the same terminal (and give up mobile sync), launch with `VIBE_GEMINI_INTERACTIVE=1 vibe gemini`; this preserves the legacy “inherit stdio” behavior.

### 3. `utils/permissionHandler.ts` - Permission Handling

**Location**: [`cli/src/gemini/utils/permissionHandler.ts`](cli/src/gemini/utils/permissionHandler.ts)

Handles tool permission requests for Gemini CLI.

**Key Features:**
- RPC-based permission requests
- Mobile app integration
- Pending request management
- State tracking

This follows the same pattern as Codex's permission handler.

### 4. `types.ts` - Type Definitions

**Location**: [`cli/src/gemini/types.ts`](cli/src/gemini/types.ts)

Type definitions specific to Gemini CLI integration.

**Key Types:**
- `GeminiSessionConfig` - Session configuration
- `GeminiToolResponse` - Tool response structure
- `GeminiMessage` - Message types

## Message Flow

### Complete Flow Diagram

```
User Input (Terminal/Mobile)
    │
    ▼
┌──────────────────────┐
│  ApiSessionClient    │
│  onUserMessage()     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   MessageQueue2      │
│   (with mode hash)   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   runGemini.ts       │
│   (main loop)        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  GeminiClient        │
│  startSession()      │
│  continueSession()   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Gemini CLI          │
│  (Process/MCP/HTTP)  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Events/Messages     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Session Client      │
│  sendGeminiMessage() │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Encryption         │
│   (encrypt())        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   WebSocket          │
│   (Socket.IO)        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Server             │
│   (stores & routes)  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Mobile App         │
│   (decrypts & shows) │
└──────────────────────┘
```

### Message Types

Gemini integration currently handles:

1. **Messages**: Assistant responses (streaming deltas are accumulated before sending to mobile)
2. **Tool Calls**: Emitted as `tool-call` events, preserving Gemini's `tool_use` metadata
3. **Tool Results**: Returned as `tool-call-result` entries
4. **Thinking**: Optional reasoning text mapped to the mobile “thinking” indicator
5. **System/Error**: Filtered to suppress Gemini's verbose debug logs so mobile only sees actionable issues

The event handler in `runGemini.ts` normalizes these types before passing them to `session.sendGeminiMessage()`.

## Session Management

### Session Creation

Sessions are created in `runGemini.ts`:

```typescript
let metadata: Metadata = {
    path: process.cwd(),
    host: os.hostname(),
    version: packageJson.version,
    os: os.platform(),
    machineId: machineId,
    homeDir: os.homedir(),
    vibeHomeDir: configuration.vibeHomeDir,
    vibeLibDir: projectPath(),
    vibeToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
    startedFromDaemon: opts.startedBy === 'daemon',
    hostPid: process.pid,
    startedBy: opts.startedBy || 'terminal',
    lifecycleState: 'running',
    lifecycleStateSince: Date.now(),
    flavor: 'gemini' // Gemini flavor
};
```

### Session ID Detection

**TODO**: Implement session ID extraction based on Gemini CLI's response format.

### Session Resume

**TODO**: Implement session resume if Gemini CLI supports it.

## Permission System

### Tool Permission Flow

Gemini uses the same RPC-based permission system as Codex:

1. **Permission Request**: Gemini sends tool call request
2. **Permission Handler**: `GeminiPermissionHandler` intercepts
3. **Agent State Update**: Pending request stored in agent state
4. **Mobile Request**: RPC call to mobile app
5. **User Decision**: User approves/denies on mobile
6. **Response**: Permission result sent back via RPC
7. **Tool Execution**: If approved, tool executes

**Implementation**: The permission handler is complete and follows the Codex pattern.

### Permission Modes

Gemini supports different permission modes (same as Codex):

- `default`: Normal permission prompts
- `read-only`: No write operations
- `safe-yolo`: Auto-approve on failure
- `yolo`: Auto-approve all

**TODO**: Map these to Gemini CLI's approval policies (if applicable).

## MCP Integration

### Vibe MCP Server Integration

Gemini connects to Vibe MCP server via STDIO bridge (same as Codex):

```typescript
const vibeServer = await startVibeServer(session);
const bridgeCommand = resolve(projectPath(), 'bin', 'vibe-mcp.mjs');
const mcpServers = {
    vibe: {
        command: bridgeCommand,
        args: ['--url', vibeServer.url]
    }
};
```

**Note**: This assumes Gemini CLI supports MCP servers. If not, this will need to be adjusted.

## Error Handling

### Abort Handling

Gemini supports aborting the current task without exiting:

```typescript
async function handleAbort() {
    logger.debug('[Gemini] Abort requested - stopping current task');
    try {
        abortController.abort();
        messageQueue.reset();
        permissionHandler.reset();
        logger.debug('[Gemini] Abort completed - session remains active');
    } catch (error) {
        logger.debug('[Gemini] Error during abort:', error);
    } finally {
        abortController = new AbortController();
    }
}
```

### Cleanup

Cleanup happens on process exit:

```typescript
finally {
    session.sendSessionDeath();
    await session.flush();
    await session.close();
    await client.disconnect();
    vibeServer.stop();
    clearInterval(keepAliveInterval);
    stopCaffeinate();
}
```

## Implementation Checklist

### Completed ✅

- [x] Directory structure created
- [x] Type definitions
- [x] Main runner (`runGemini.ts`)
- [x] Permission handler
- [x] Command registration in `index.ts`
- [x] `sendGeminiMessage()` in `apiSession.ts`
- [x] Basic session management
- [x] Message queue setup
- [x] Cleanup handlers

### TODO / Status

- [x] **Determine Gemini CLI interface**: Process spawning with `--output-format stream-json`
- [x] **Implement `GeminiClient.connect()` / `startSession()`**: Spawn CLI, parse stdout
- [x] **Implement `GeminiClient.continueSession()`**: Reuse cwd/model for follow-up prompts
- [x] **Implement message parsing and event handler**: Normalized in `runGemini.ts`
- [x] **Implement session ID extraction**: Captures identifiers from CLI messages
- [ ] **Implement session resume**: Blocked on upstream CLI support
- [x] **Test integration**: Covered by `src/gemini/geminiClient.test.ts` smoke tests
- [x] **Update documentation**: Reflect current behavior and config overrides

## Next Steps

1. **Session resume + history**  
   Track upstream Gemini CLI changes for a `--resume`/`--session` flag and persist the identifiers surfaced by `GeminiClient.storeSessionForResume()` so multi-turn context survives process restarts.

2. **Permission mode parity**  
   Wire `GeminiPermissionHandler` into real tool execution once the CLI exposes hooks for approval workflows, and map Vibe's `read-only`, `safe-yolo`, and `yolo` modes accordingly.

3. **Full CLI validation**  
   Extend the new Vitest smoke tests to optionally spawn the real Gemini binary (via `VIBE_GEMINI_BIN`) inside CI once stable credentials/fixtures are available, ensuring regressions are caught automatically.

## Code Examples

### Starting a Gemini Session

```typescript
import { runGemini } from '@/gemini/runGemini';
import { readCredentials } from '@/persistence';

const credentials = await readCredentials();
await runGemini({
    credentials,
    startedBy: 'terminal'
});
```

### Sending Messages to Mobile

```typescript
// Send assistant message
session.sendGeminiMessage({
    type: 'message',
    message: 'Hello from Gemini!',
    id: randomUUID()
});

// Send tool call
session.sendGeminiMessage({
    type: 'tool-call',
    name: 'GeminiTool',
    callId: randomUUID(),
    input: { /* tool input */ },
    id: randomUUID()
});

// Send tool result
session.sendGeminiMessage({
    type: 'tool-call-result',
    callId: toolCallId,
    output: { /* tool output */ },
    id: randomUUID()
});
```

## Separation of Concerns

This integration maintains complete separation from Claude and Codex:

- **Separate directory**: `cli/src/gemini/`
- **Separate types**: `cli/src/gemini/types.ts`
- **Separate client**: `cli/src/gemini/geminiClient.ts`
- **Separate message type**: `type: 'gemini'` in `sendGeminiMessage()`
- **Separate flavor**: `flavor: 'gemini'` in metadata
- **No shared code**: Each agent uses its own implementation

This ensures that:
- Changes to Claude don't affect Gemini
- Changes to Codex don't affect Gemini
- Each agent can evolve independently
- No mixing of agent-specific logic

## Summary

This document has covered:

- **Architecture**: High-level system design
- **Integration Method**: To be determined based on Gemini CLI interface
- **Key Components**: Main files and their responsibilities
- **Message Flow**: Complete data flow from input to mobile
- **Session Management**: Creation, detection, resume (to be implemented)
- **Permission System**: RPC-based approval flow (complete)
- **MCP Integration**: Vibe MCP server connection (assumed)
- **Error Handling**: Abort, cleanup, recovery
- **Implementation Checklist**: What's done and what's TODO
- **Separation of Concerns**: How Gemini is kept separate from other agents

For questions or contributions, refer to the main project documentation in `AGENTS.md`.

---

*Last updated: 2025-01-27*
*Status: In Progress - Core structure complete, client implementation pending*

