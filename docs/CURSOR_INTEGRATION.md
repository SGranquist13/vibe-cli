# Cursor CLI Integration Documentation

## Introduction

This document explains how Vibe-on-the-Go integrates with Cursor CLI (`cursor-agent`), covering the architecture, message flow, integration method, and extensibility patterns. This serves as a reference for understanding the current implementation and for adding support for new agents in the future.

## Architecture Overview

Vibe-on-the-Go integrates with Cursor CLI through a **process-based system** that spawns `cursor-agent` as a subprocess.

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
│ CursorClient    │ (Process Spawning)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  cursor-agent   │ (Subprocess)
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

### Process-Based Integration

Cursor CLI integration uses process spawning via Node.js `child_process`:

- **Executable**: `cursor-agent` (installed via Cursor CLI installation script)
- **Transport**: STDIO (standard input/output)
- **Output Parsing**: JSON lines or text parsing
- **Session Management**: Process lifecycle management

**Key Characteristics:**
- Interactive mode for terminal-based usage
- Non-interactive mode with `-p` flag for automation
- Model selection support
- MCP server configuration

**Implementation**: [`cli/src/cursor/cursorClient.ts`](../src/cursor/cursorClient.ts)

## Key Components

### 1. `runCursor.ts` - Main Entry Point

**Location**: [`cli/src/cursor/runCursor.ts`](../src/cursor/runCursor.ts)

This is the main entry point for Cursor CLI sessions. It handles:

- Session creation and initialization
- Message queue setup
- Cursor client connection
- Message processing and routing
- Permission handling
- Cleanup and lifecycle management

**Key Responsibilities:**

```typescript
export async function runCursor(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void>
```

The implementation follows the same pattern as `runGemini.ts` and `runCodex.ts` but maintains complete separation.

### 2. `cursorClient.ts` - Cursor Client Implementation

**Location**: [`cli/src/cursor/cursorClient.ts`](../src/cursor/cursorClient.ts)

Wraps communication with cursor-agent via process spawning.

**Key Methods:**
- `connect()` - Initialize client (no-op for process spawning)
- `startSession(config, options)` - Spawn cursor-agent process
- `continueSession(prompt, options)` - Continue with new prompt
- `clearSession()` - Kill process and reset state
- `disconnect()` - Cleanup connection

**Features:**
- Cross-platform executable detection (Windows, macOS, Linux)
- Interactive and non-interactive mode support
- Output parsing (JSON and text)
- Session ID tracking
- Abort signal handling

### 3. `utils/permissionHandler.ts` - Permission Handling

**Location**: [`cli/src/cursor/utils/permissionHandler.ts`](../src/cursor/utils/permissionHandler.ts)

Handles tool permission requests for Cursor CLI.

**Key Features:**
- RPC-based permission requests
- Mobile app integration
- Pending request management
- State tracking via agent state

This follows the same pattern as Codex and Gemini permission handlers.

### 4. `types.ts` - Type Definitions

**Location**: [`cli/src/cursor/types.ts`](../src/cursor/types.ts)

Type definitions specific to Cursor CLI integration.

**Key Types:**
- `CursorSessionConfig` - Session configuration
- `CursorToolResponse` - Tool response structure
- `CursorMessageType` - Message type enum
- `CursorMessage` - Message structure
- `CursorPermissionResult` - Permission result structure

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
│   runCursor.ts       │
│   (main loop)        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  CursorClient        │
│  startSession()      │
│  continueSession()   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  cursor-agent        │
│  (subprocess)        │
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
│  sendCursorMessage() │
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

Cursor integration handles several message types:

1. **message/assistant**: Text messages from Cursor
2. **tool_call/function_call**: Tool/function call requests
3. **tool_result/function_result**: Tool/function execution results
4. **thinking/reasoning**: Thinking/reasoning indicators
5. **error**: Error messages
6. **system**: System messages
7. **done/complete/finished**: Task completion indicators

## Session Management

### Session Creation

Sessions are created in `runCursor.ts`:

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
    flavor: 'cursor' // Cursor flavor
};
```

### Session ID Detection

Session IDs are extracted from cursor-agent output:

```typescript
private updateIdentifiersFromMessage(message: any): void {
    const sessionId = message.sessionId || message.session_id || message.session?.id;
    if (sessionId && !this.sessionId) {
        this.sessionId = sessionId;
    }
}
```

### Session Resume

Session resume is supported if cursor-agent provides session persistence:

```typescript
storeSessionForResume(): string | null {
    return this.sessionId;
}
```

## Permission System

### Tool Permission Flow

Cursor uses the same RPC-based permission system as Codex and Gemini:

1. **Permission Request**: cursor-agent sends tool call request
2. **Permission Handler**: `CursorPermissionHandler` intercepts
3. **Agent State Update**: Pending request stored in agent state
4. **Mobile Request**: RPC call to mobile app
5. **User Decision**: User approves/denies on mobile
6. **Response**: Permission result sent back via RPC
7. **Tool Execution**: If approved, tool executes

### Permission Modes

Cursor supports different permission modes:

- `default`: Normal permission prompts
- `read-only`: No write operations
- `safe-yolo`: Auto-approve on failure
- `yolo`: Auto-approve all

## MCP Integration

### Vibe MCP Server Integration

Cursor connects to Vibe MCP server via STDIO bridge:

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

**Note**: This assumes cursor-agent supports MCP servers via configuration. The actual implementation may vary based on cursor-agent's MCP support.

## Error Handling

### Abort Handling

Cursor supports aborting the current task without exiting:

```typescript
async function handleAbort() {
    logger.debug('[Cursor] Abort requested - stopping current task');
    try {
        abortController.abort();
        messageQueue.reset();
        permissionHandler.reset();
        logger.debug('[Cursor] Abort completed - session remains active');
    } catch (error) {
        logger.debug('[Cursor] Error during abort:', error);
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

## Usage

### Starting a Cursor Session

From the command line:

```bash
vibe cursor
```

With daemon spawn:

```bash
vibe cursor --started-by daemon
```

### Programmatic Usage

```typescript
import { runCursor } from '@/cursor/runCursor';
import { readCredentials } from '@/persistence';

const credentials = await readCredentials();
await runCursor({
    credentials,
    startedBy: 'terminal'
});
```

### Sending Messages to Mobile

```typescript
// Send assistant message
session.sendCursorMessage({
    type: 'message',
    message: 'Hello from Cursor!',
    id: randomUUID()
});

// Send tool call
session.sendCursorMessage({
    type: 'tool-call',
    name: 'CursorTool',
    callId: randomUUID(),
    input: { /* tool input */ },
    id: randomUUID()
});

// Send tool result
session.sendCursorMessage({
    type: 'tool-call-result',
    callId: toolCallId,
    output: { /* tool output */ },
    id: randomUUID()
});
```

## Separation of Concerns

This integration maintains complete separation from Claude, Codex, and Gemini:

- **Separate directory**: `cli/src/cursor/`
- **Separate types**: `cli/src/cursor/types.ts`
- **Separate client**: `cli/src/cursor/cursorClient.ts`
- **Separate message type**: `type: 'cursor'` in `sendCursorMessage()`
- **Separate flavor**: `flavor: 'cursor'` in metadata
- **No shared code**: Each agent uses its own implementation

This ensures that:
- Changes to Claude don't affect Cursor
- Changes to Codex don't affect Cursor
- Changes to Gemini don't affect Cursor
- Each agent can evolve independently
- No mixing of agent-specific logic

## Installation Requirements

### Installing Cursor CLI

Cursor CLI (`cursor-agent`) can be installed via:

```bash
curl https://cursor.com/install -fsS | bash
```

After installation, verify:

```bash
cursor-agent --version
```

Ensure `~/.local/bin` is in your PATH.

## Summary

This document has covered:

- **Architecture**: Process-based integration via subprocess
- **Integration Method**: cursor-agent spawning with STDIO
- **Key Components**: Main files and their responsibilities
- **Message Flow**: Complete data flow from input to mobile
- **Session Management**: Creation, detection, resume, lifecycle
- **Permission System**: RPC-based approval flow
- **MCP Integration**: Vibe MCP server connection
- **Error Handling**: Abort, cleanup, recovery
- **Separation of Concerns**: How Cursor is kept separate from other agents

For questions or contributions, refer to the main project documentation in `AGENTS.md`.

---

*Last updated: 2025-01-27*
*Status: Initial implementation complete*




