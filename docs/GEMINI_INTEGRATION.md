# Gemini CLI Integration Documentation

## Introduction

This document explains how Vibe-on-the-Go integrates with Gemini CLI, covering the architecture, message flow, integration method, and extensibility patterns. This serves as a reference for understanding the current implementation and for completing the integration.

**⚠️ Status: This integration is in progress and requires completion of the Gemini CLI client implementation.**

## Architecture Overview

Vibe-on-the-Go integrates with Gemini CLI through a **process-based or MCP-based system** (to be determined based on Gemini CLI's interface).

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

### To Be Determined

The integration method depends on how Gemini CLI exposes its interface. Based on the [Gemini CLI documentation](https://github.com/google-gemini/gemini-cli), possible approaches:

1. **Process Spawning** (like Claude Code)
   - Spawn `gemini` CLI process
   - Use `--output-format stream-json` for structured output
   - Parse stdout/stderr for messages

2. **MCP Protocol** (like Codex)
   - Connect via MCP stdio transport
   - Use MCP events for messages
   - Tool calls via MCP protocol

3. **HTTP API** (if available)
   - REST or WebSocket API
   - Direct HTTP communication

**Current Status**: The `GeminiClient` class is a skeleton that needs implementation based on the chosen method.

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

Wraps communication with Gemini CLI. Currently a skeleton that needs implementation.

**Key Methods:**
- `connect()` - Connect to Gemini CLI
- `startSession()` - Start a new session
- `continueSession()` - Continue existing session
- `disconnect()` - Cleanup connection

**TODO**: Implement based on Gemini CLI's interface:
- Determine if Gemini CLI uses process spawning, MCP, or HTTP
- Implement message parsing
- Handle session management
- Process tool calls and responses

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

Gemini integration will handle several message types (to be determined based on Gemini CLI's output):

1. **Messages**: Text messages from Gemini
2. **Tool Calls**: Requests to execute tools
3. **Tool Results**: Results from tool execution
4. **Thinking**: Reasoning/thinking indicators
5. **System**: System messages and errors

**Implementation**: The event handler in `runGemini.ts` needs to be completed to process Gemini-specific message types.

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

### TODO 🔲

- [ ] **Determine Gemini CLI interface**: Process spawning, MCP, or HTTP?
- [ ] **Implement `GeminiClient.connect()`**: Based on chosen interface
- [ ] **Implement `GeminiClient.startSession()`**: Start Gemini CLI session
- [ ] **Implement `GeminiClient.continueSession()`**: Continue existing session
- [ ] **Implement message parsing**: Parse Gemini CLI output/events
- [ ] **Implement event handler**: Process Gemini-specific message types
- [ ] **Implement session ID extraction**: Extract from Gemini responses
- [ ] **Implement session resume**: If Gemini CLI supports it
- [ ] **Test integration**: End-to-end testing
- [ ] **Update documentation**: Complete this document with actual implementation details

## Next Steps

1. **Research Gemini CLI Interface**:
   - Check if Gemini CLI supports MCP
   - Check if it uses process spawning with structured output
   - Check if it has an HTTP API
   - Review Gemini CLI source code/documentation

2. **Implement GeminiClient**:
   - Choose integration method
   - Implement connection logic
   - Implement session management
   - Implement message parsing

3. **Implement Message Processing**:
   - Parse Gemini CLI output
   - Convert to standard message format
   - Handle tool calls and results
   - Handle thinking/status messages

4. **Testing**:
   - Test session creation
   - Test message flow
   - Test permission handling
   - Test cleanup

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

