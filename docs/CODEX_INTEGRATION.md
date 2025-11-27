# Codex Integration Documentation

## Introduction

This document explains how Vibe-on-the-Go integrates with Codex, covering the architecture, message flow, MCP protocol, permissions, and extensibility patterns. This serves as a reference for understanding the current implementation and for adding support for new agents in the future.

## Architecture Overview

Vibe-on-the-Go integrates with Codex through the **Model Context Protocol (MCP)**. Unlike Claude Code's dual-mode system, Codex uses a single integration method via MCP stdio communication.

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
│ CodexMcpClient  │ (MCP Client)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Codex Process  │ (via MCP stdio)
│  (codex mcp)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  MCP Events     │ (agent_message, tool calls, etc.)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Processors     │ (Reasoning, Diff, Permissions)
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

### MCP-Based Integration

Codex integration uses the Model Context Protocol (MCP) via stdio transport:

- **Protocol**: MCP (Model Context Protocol)
- **Transport**: STDIO (standard input/output)
- **Client**: `CodexMcpClient` wraps MCP SDK client
- **Server**: Codex's built-in MCP server (`codex mcp-server` or `codex mcp`)

**Key Characteristics:**
- Single integration method (no mode switching)
- Event-driven message processing
- Tool permission via MCP elicitation protocol
- Session/conversation ID tracking
- Resume support via experimental_resume config

**Implementation**: [`cli/src/codex/codexMcpClient.ts`](cli/src/codex/codexMcpClient.ts)

## Key Components

### 1. `runCodex.ts` - Main Entry Point

**Location**: [`cli/src/codex/runCodex.ts`](cli/src/codex/runCodex.ts)

This is the main entry point for Codex sessions. It handles:

- Session creation and initialization
- Message queue setup
- MCP client connection
- Message processing and routing
- Permission handling
- Reasoning and diff processing
- Ink UI rendering (terminal)

**Key Responsibilities:**

```62:137:cli/src/codex/runCodex.ts
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    type PermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
    }

    //
    // Define session
    //

    const sessionTag = randomUUID();
    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/your-username/vibe-on-the-go/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    let state: AgentState = {
        controlledByUser: false,
    }
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
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'codex'
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);
```

**Message Queue Setup:**

```139:179:cli/src/codex/runCodex.ts
    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides to apply per message
    let currentPermissionMode: PermissionMode | undefined = undefined;
    let currentModel: string | undefined = undefined;

    session.onUserMessage((message) => {
        // Resolve permission mode (validate)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Codex] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
        };
        messageQueue.push(message.content.text, enhancedMode);
    });
```

### 2. `codexMcpClient.ts` - MCP Client Implementation

**Location**: [`cli/src/codex/codexMcpClient.ts`](cli/src/codex/codexMcpClient.ts)

Wraps the MCP SDK client and handles communication with Codex:

```46:107:cli/src/codex/codexMcpClient.ts
export class CodexMcpClient {
    private client: Client;
    private transport: StdioClientTransport | null = null;
    private connected: boolean = false;
    private sessionId: string | null = null;
    private conversationId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;

    constructor() {
        this.client = new Client(
            { name: 'vibe-codex-client', version: '1.0.0' },
            { capabilities: { tools: {}, elicitation: {} } }
        );

        this.client.setNotificationHandler(z.object({
            method: z.literal('codex/event'),
            params: z.object({
                msg: z.any()
            })
        }).passthrough(), (data) => {
            const msg = data.params.msg;
            this.updateIdentifiersFromEvent(msg);
            this.handler?.(msg);
        });
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    /**
     * Set the permission handler for tool approval
     */
    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const mcpCommand = getCodexMcpCommand();
        logger.debug(`[CodexMCP] Connecting to Codex MCP server using command: codex ${mcpCommand}`);

        this.transport = new StdioClientTransport({
            command: 'codex',
            args: [mcpCommand],
            env: Object.keys(process.env).reduce((acc, key) => {
                const value = process.env[key];
                if (typeof value === 'string') acc[key] = value;
                return acc;
            }, {} as Record<string, string>)
        });

        // Register request handlers for Codex permission methods
        this.registerPermissionHandlers();

        await this.client.connect(this.transport);
        this.connected = true;

        logger.debug('[CodexMCP] Connected to Codex');
    }
```

**Key Features:**
- Version detection for MCP command (`mcp` vs `mcp-server`)
- STDIO transport setup
- Event notification handling
- Session/conversation ID tracking
- Permission handler registration

**Session Management:**

```164:214:cli/src/codex/codexMcpClient.ts
    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        logger.debug('[CodexMCP] Starting Codex session:', config);

        const response = await this.client.callTool({
            name: 'codex',
            arguments: config as any
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT,
            // maxTotalTimeout: 10000000000 
        });

        logger.debug('[CodexMCP] startSession response:', response);

        // Extract session / conversation identifiers from response if present
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }

    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        if (!this.sessionId) {
            throw new Error('No active session. Call startSession first.');
        }

        if (!this.conversationId) {
            // Some Codex deployments reuse the session ID as the conversation identifier
            this.conversationId = this.sessionId;
            logger.debug('[CodexMCP] conversationId missing, defaulting to sessionId:', this.conversationId);
        }

        const args = { sessionId: this.sessionId, conversationId: this.conversationId, prompt };
        logger.debug('[CodexMCP] Continuing Codex session:', args);

        const response = await this.client.callTool({
            name: 'codex-reply',
            arguments: args
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT
        });

        logger.debug('[CodexMCP] continueSession response:', response);
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }
```

### 3. `vibeMcpStdioBridge.ts` - STDIO Bridge for Vibe Tools

**Location**: [`cli/src/codex/vibeMcpStdioBridge.ts`](cli/src/codex/vibeMcpStdioBridge.ts)

Provides a STDIO MCP server that bridges to the Vibe HTTP MCP server, allowing Codex to use Vibe tools:

```32:107:cli/src/codex/vibeMcpStdioBridge.ts
async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.VIBE_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[vibe-mcp] Missing target URL. Set VIBE_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: 'vibe-stdio-bridge', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    httpClient = client;
    return client;
  }

  // Create STDIO MCP server
  const server = new McpServer({
    name: 'Vibe MCP Bridge',
    version: '1.0.0',
    description: 'STDIO bridge forwarding to Vibe HTTP MCP',
  });

  // Register the single tool and forward to HTTP MCP
  server.registerTool(
    'change_title',
    {
      description: 'Change the title of the current chat session',
      title: 'Change Chat Title',
      inputSchema: {
        title: z.string().describe('The new title for the chat session'),
      },
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        const response = await client.callTool({ name: 'change_title', arguments: args });
        // Pass-through response from HTTP server
        return response as any;
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Failed to change chat title: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    }
  );

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}
```

**Purpose:**
- Codex requires STDIO MCP servers (not HTTP)
- Vibe MCP server runs as HTTP
- Bridge converts STDIO ↔ HTTP
- Allows Codex to use Vibe tools (e.g., `change_title`)

### 4. `utils/permissionHandler.ts` - Permission Handling

**Location**: [`cli/src/codex/utils/permissionHandler.ts`](cli/src/codex/utils/permissionHandler.ts)

Handles tool permission requests via MCP elicitation protocol:

```29:86:cli/src/codex/utils/permissionHandler.ts
export class CodexPermissionHandler {
    private pendingRequests = new Map<string, PendingRequest>();
    private session: ApiSessionClient;

    constructor(session: ApiSessionClient) {
        this.session = session;
        this.setupRpcHandler();
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input
            });

            // Send push notification
            // this.session.api.push().sendToAllDevices(
            //     'Permission Request',
            //     `Codex wants to use ${toolName}`,
            //     {
            //         sessionId: this.session.sessionId,
            //         requestId: toolCallId,
            //         tool: toolName,
            //         type: 'permission_request'
            //     }
            // );

            // Update agent state with pending request
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            logger.debug(`[Codex] Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }
```

**Permission Flow:**
1. Codex sends elicitation request via MCP
2. `CodexMcpClient` intercepts and calls permission handler
3. Handler stores pending request and updates agent state
4. Mobile app receives request via RPC
5. User approves/denies
6. Response sent back via RPC
7. Handler resolves promise with decision

### 5. `utils/reasoningProcessor.ts` - Reasoning Message Processing

**Location**: [`cli/src/codex/utils/reasoningProcessor.ts`](cli/src/codex/utils/reasoningProcessor.ts)

Processes streaming reasoning deltas and converts them to tool calls:

```39:122:cli/src/codex/utils/reasoningProcessor.ts
export class ReasoningProcessor {
    private accumulator: string = '';
    private inTitleCapture: boolean = false;
    private titleBuffer: string = '';
    private contentBuffer: string = '';
    private hasTitle: boolean = false;
    private currentCallId: string | null = null;
    private toolCallStarted: boolean = false;
    private currentTitle: string | null = null;
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
        this.reset();
    }

    /**
     * Set the message callback for sending messages directly
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }

    /**
     * Process a reasoning section break - indicates a new reasoning section is starting
     */
    handleSectionBreak(): void {
        this.finishCurrentToolCall('canceled');
        this.resetState();
        logger.debug('[ReasoningProcessor] Section break - reset state');
    }

    /**
     * Process a reasoning delta and accumulate content
     */
    processDelta(delta: string): void {
        this.accumulator += delta;

        // If we haven't started processing yet, check if this starts with **
        if (!this.inTitleCapture && !this.hasTitle && !this.contentBuffer) {
            if (this.accumulator.startsWith('**')) {
                // Start title capture
                this.inTitleCapture = true;
                this.titleBuffer = this.accumulator.substring(2); // Remove leading **
                logger.debug('[ReasoningProcessor] Started title capture');
            } else if (this.accumulator.length > 0) {
                // This is untitled reasoning, just accumulate as content
                this.contentBuffer = this.accumulator;
            }
        } else if (this.inTitleCapture) {
            // We're capturing the title
            this.titleBuffer = this.accumulator.substring(2); // Keep updating from start
            
            // Check if we've found the closing **
            const titleEndIndex = this.titleBuffer.indexOf('**');
            if (titleEndIndex !== -1) {
                // Found the end of title
                const title = this.titleBuffer.substring(0, titleEndIndex);
                const afterTitle = this.titleBuffer.substring(titleEndIndex + 2);
                
                this.hasTitle = true;
                this.inTitleCapture = false;
                this.currentTitle = title;
                this.contentBuffer = afterTitle;
                
                // Generate a call ID for this reasoning section
                this.currentCallId = randomUUID();
                
                logger.debug(`[ReasoningProcessor] Title captured: "${title}"`);
                
                // Send tool call immediately when title is detected
                this.sendToolCallStart(title);
            }
        } else if (this.hasTitle) {
            // We have a title, accumulate content after title
            this.contentBuffer = this.accumulator.substring(
                this.accumulator.indexOf('**') + 2 + 
                this.currentTitle!.length + 2
            );
        } else {
            // Untitled reasoning, just accumulate
            this.contentBuffer = this.accumulator;
        }
    }
```

**Purpose:**
- Converts reasoning sections with `**[Title]**` format into tool calls
- Untitled reasoning becomes regular messages
- Provides structured output for mobile app

### 6. `utils/diffProcessor.ts` - Diff Message Processing

**Location**: [`cli/src/codex/utils/diffProcessor.ts`](cli/src/codex/utils/diffProcessor.ts)

Processes `turn_diff` messages and tracks unified_diff changes:

```30:78:cli/src/codex/utils/diffProcessor.ts
export class DiffProcessor {
    private previousDiff: string | null = null;
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
    }

    /**
     * Process a turn_diff message and check if the unified_diff has changed
     */
    processDiff(unifiedDiff: string): void {
        // Check if the diff has changed from the previous value
        if (this.previousDiff !== unifiedDiff) {
            logger.debug('[DiffProcessor] Unified diff changed, sending CodexDiff tool call');
            
            // Generate a unique call ID for this diff
            const callId = randomUUID();
            
            // Send tool call for the diff change
            const toolCall: DiffToolCall = {
                type: 'tool-call',
                name: 'CodexDiff',
                callId: callId,
                input: {
                    unified_diff: unifiedDiff
                },
                id: randomUUID()
            };
            
            this.onMessage?.(toolCall);
            
            // Immediately send the tool result to mark it as completed
            const toolResult: DiffToolResult = {
                type: 'tool-call-result',
                callId: callId,
                output: {
                    status: 'completed'
                },
                id: randomUUID()
            };
            
            this.onMessage?.(toolResult);
        }
        
        // Update the stored diff value
        this.previousDiff = unifiedDiff;
        logger.debug('[DiffProcessor] Updated stored diff');
    }
```

**Purpose:**
- Tracks file changes via unified_diff
- Sends diff updates as tool calls
- Resets on task completion

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
│   runCodex.ts        │
│   (main loop)        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  CodexMcpClient      │
│  startSession()      │
│  continueSession()   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Codex Process       │
│  (via MCP stdio)     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  MCP Events         │
│  (codex/event)      │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Event Handler       │
│  (in runCodex.ts)   │
└──────────┬───────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
┌─────────┐  ┌──────────┐
│Reasoning│  │   Diff   │
│Processor│  │Processor │
└────┬────┘  └─────┬────┘
     │             │
     └──────┬──────┘
            │
            ▼
┌──────────────────────┐
│  Session Client      │
│  sendCodexMessage() │
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

Codex integration handles several MCP event types:

1. **agent_message**: Text messages from Codex
2. **agent_reasoning**: Complete reasoning sections
3. **agent_reasoning_delta**: Streaming reasoning updates
4. **agent_reasoning_section_break**: New reasoning section starting
5. **exec_command_begin**: Command execution started
6. **exec_command_end**: Command execution completed
7. **exec_approval_request**: Permission request for command
8. **patch_apply_begin**: File patch operation started
9. **patch_apply_end**: File patch operation completed
10. **turn_diff**: Unified diff for file changes
11. **task_started**: New task started
12. **task_complete**: Task completed
13. **turn_aborted**: Task aborted
14. **token_count**: Token usage information

**Event Handler Implementation:**

```393:534:cli/src/codex/runCodex.ts
    client.setHandler((msg) => {
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            sendReady();
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'agent_message') {
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
            let { call_id, type, ...inputs } = msg;
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_end') {
            let { call_id, type, ...output } = msg;
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: output,
                id: randomUUID()
            });
        }
        if (msg.type === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_begin') {
            // Handle the start of a patch operation
            let { call_id, auto_approved, changes } = msg;

            // Add UI feedback for patch operation
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

            // Send tool call message
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexPatch',
                callId: call_id,
                input: {
                    auto_approved,
                    changes
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_end') {
            // Handle the end of a patch operation
            let { call_id, stdout, stderr, success } = msg;

            // Add UI feedback for completion
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }

            // Send tool call result message
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: {
                    stdout,
                    stderr,
                    success
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }
    });
```

### Encryption Flow

All messages are encrypted before transmission (same as Claude Code):

```typescript
// Encryption happens in ApiSessionClient
const encrypted = encrypt(encryptionKey, variant, messageData);
const encoded = encodeBase64(encrypted);
// Send via WebSocket
```

## Session Management

### Session Creation

Sessions are created in `runCodex.ts`:

```102:123:cli/src/codex/runCodex.ts
    let state: AgentState = {
        controlledByUser: false,
    }
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
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'codex'
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);
```

### Session ID Detection

Session IDs are extracted from MCP events and tool responses:

```217:272:cli/src/codex/codexMcpClient.ts
    private updateIdentifiersFromEvent(event: any): void {
        if (!event || typeof event !== 'object') {
            return;
        }

        const candidates: any[] = [event];
        if (event.data && typeof event.data === 'object') {
            candidates.push(event.data);
        }

        for (const candidate of candidates) {
            const sessionId = candidate.session_id ?? candidate.sessionId;
            if (sessionId) {
                this.sessionId = sessionId;
                logger.debug('[CodexMCP] Session ID extracted from event:', this.sessionId);
            }

            const conversationId = candidate.conversation_id ?? candidate.conversationId;
            if (conversationId) {
                this.conversationId = conversationId;
                logger.debug('[CodexMCP] Conversation ID extracted from event:', this.conversationId);
            }
        }
    }
    private extractIdentifiers(response: any): void {
        const meta = response?.meta || {};
        if (meta.sessionId) {
            this.sessionId = meta.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        } else if (response?.sessionId) {
            this.sessionId = response.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        }

        if (meta.conversationId) {
            this.conversationId = meta.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        } else if (response?.conversationId) {
            this.conversationId = response.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        }

        const content = response?.content;
        if (Array.isArray(content)) {
            for (const item of content) {
                if (!this.sessionId && item?.sessionId) {
                    this.sessionId = item.sessionId;
                    logger.debug('[CodexMCP] Session ID extracted from content:', this.sessionId);
                }
                if (!this.conversationId && item && typeof item === 'object' && 'conversationId' in item && item.conversationId) {
                    this.conversationId = item.conversationId;
                    logger.debug('[CodexMCP] Conversation ID extracted from content:', this.conversationId);
                }
            }
        }
    }
```

### Session Resume

Codex supports session resume via `experimental_resume` config:

```648:671:cli/src/codex/runCodex.ts
                    // Check for resume file from multiple sources
                    let resumeFile: string | null = null;
                    
                    // Priority 1: Explicit resume file from mode change
                    if (nextExperimentalResume) {
                        resumeFile = nextExperimentalResume;
                        nextExperimentalResume = null; // consume once
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    }
                    // Priority 2: Resume from stored abort session
                    else if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null; // consume once
                    }
                    
                    // Apply resume file if found
                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                    }
```

**Resume File Discovery:**

```343:382:cli/src/codex/runCodex.ts
    // Helper: find Codex session transcript for a given sessionId
    function findCodexResumeFile(sessionId: string | null): string | null {
        if (!sessionId) return null;
        try {
            const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
            const rootDir = join(codexHomeDir, 'sessions');

            // Recursively collect all files under the sessions directory
            function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return acc;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        collectFilesRecursive(full, acc);
                    } else if (entry.isFile()) {
                        acc.push(full);
                    }
                }
                return acc;
            }

            const candidates = collectFilesRecursive(rootDir)
                .filter(full => full.endsWith(`-${sessionId}.jsonl`))
                .filter(full => {
                    try { return fs.statSync(full).isFile(); } catch { return false; }
                })
                .sort((a, b) => {
                    const sa = fs.statSync(a).mtimeMs;
                    const sb = fs.statSync(b).mtimeMs;
                    return sb - sa; // newest first
                });
            return candidates[0] || null;
        } catch {
            return null;
        }
    }
```

### Session Lifecycle

Similar to Claude Code, sessions have lifecycle states:

```268:276:cli/src/codex/runCodex.ts
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
```

## Permission System

### Tool Permission Flow

Codex uses MCP's elicitation protocol for tool permissions:

1. **Elicitation Request**: Codex sends `elicitation` request via MCP
2. **Permission Handler**: `CodexMcpClient` intercepts and calls `CodexPermissionHandler`
3. **Agent State Update**: Pending request stored in agent state
4. **Mobile Request**: RPC call to mobile app
5. **User Decision**: User approves/denies on mobile
6. **Response**: Permission result sent back via RPC
7. **Elicitation Response**: Handler returns decision to Codex

**Implementation:**

```109:162:cli/src/codex/codexMcpClient.ts
    private registerPermissionHandlers(): void {
        // Register handler for exec command approval requests
        this.client.setRequestHandler(
            ElicitRequestSchema,
            async (request) => {
                console.log('[CodexMCP] Received elicitation request:', request.params);

                // Load params
                const params = request.params as unknown as {
                    message: string,
                    codex_elicitation: string,
                    codex_mcp_tool_call_id: string,
                    codex_event_id: string,
                    codex_call_id: string,
                    codex_command: string[],
                    codex_cwd: string
                }
                const toolName = 'CodexBash';

                // If no permission handler set, deny by default
                if (!this.permissionHandler) {
                    logger.debug('[CodexMCP] No permission handler set, denying by default');
                    return {
                        decision: 'denied' as const,
                    };
                }

                try {
                    // Request permission through the handler
                    const result = await this.permissionHandler.handleToolCall(
                        params.codex_call_id,
                        toolName,
                        {
                            command: params.codex_command,
                            cwd: params.codex_cwd
                        }
                    );

                    logger.debug('[CodexMCP] Permission result:', result);
                    return {
                        decision: result.decision
                    }
                } catch (error) {
                    logger.debug('[CodexMCP] Error handling permission request:', error);
                    return {
                        decision: 'denied' as const,
                        reason: error instanceof Error ? error.message : 'Permission request failed'
                    };
                }
            }
        );

        logger.debug('[CodexMCP] Permission handlers registered');
    }
```

### Permission Modes

Codex supports different permission modes:

- `default`: Normal permission prompts (untrusted approval policy)
- `read-only`: No write operations (never approval policy)
- `safe-yolo`: Auto-approve on failure (on-failure approval policy)
- `yolo`: Auto-approve all (on-failure approval policy, full access sandbox)

These map to Codex's approval policies and sandbox modes:

```619:635:cli/src/codex/runCodex.ts
                // Map permission mode to approval policy and sandbox for startSession
                const approvalPolicy = (() => {
                    switch (message.mode.permissionMode) {
                        case 'default': return 'untrusted' as const;
                        case 'read-only': return 'never' as const;
                        case 'safe-yolo': return 'on-failure' as const;
                        case 'yolo': return 'on-failure' as const;
                    }
                })();
                const sandbox = (() => {
                    switch (message.mode.permissionMode) {
                        case 'default': return 'workspace-write' as const;
                        case 'read-only': return 'read-only' as const;
                        case 'safe-yolo': return 'workspace-write' as const;
                        case 'yolo': return 'danger-full-access' as const;
                    }
                })();
```

## MCP Integration

### Vibe MCP Server Integration

Codex connects to Vibe MCP server via STDIO bridge:

**Configuration:**

```536:544:cli/src/codex/runCodex.ts
    // Start Vibe MCP server (HTTP) and prepare STDIO bridge config for Codex
    const vibeServer = await startVibeServer(session);
    const bridgeCommand = join(projectPath(), 'bin', 'vibe-mcp.mjs');
    const mcpServers = {
        vibe: {
            command: bridgeCommand,
            args: ['--url', vibeServer.url]
        }
    } as const;
```

**Bridge Setup:**

The bridge (`vibeMcpStdioBridge.ts`) runs as a separate process and forwards tool calls from Codex (STDIO) to Vibe MCP server (HTTP).

### System Prompt Integration

Codex receives instructions to use the title tool in the first message:

```639:639:cli/src/codex/runCodex.ts
                        prompt: first ? message.message + '\n\n' + trimIdent(`Based on this message, call functions.vibe__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`) : message.message,
```

## Error Handling

### Abort Handling

Codex supports aborting the current task without exiting:

```234:254:cli/src/codex/runCodex.ts
    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            // Store the current session ID before aborting for potential resume
            if (client.hasActiveSession()) {
                storedSessionIdForResume = client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
            }
            
            abortController.abort();
            messageQueue.reset();
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }
```

**Abort vs Kill:**
- **Abort**: Stops current task, keeps session alive
- **Kill**: Terminates entire process

### Cleanup

Cleanup happens on process exit:

```724:768:cli/src/codex/runCodex.ts
    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');
        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        // Stop Vibe MCP server
        logger.debug('[codex]: vibeServer.stop');
        vibeServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
```

### Mode Change Handling

When permission mode or model changes, Codex restarts the session:

```583:612:cli/src/codex/runCodex.ts
            // If a session exists and mode changed, restart on next iteration
            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                // Capture previous sessionId and try to find its transcript to resume
                try {
                    const prevSessionId = client.getSessionId();
                    nextExperimentalResume = findCodexResumeFile(prevSessionId);
                    if (nextExperimentalResume) {
                        logger.debug(`[Codex] Found resume file for session ${prevSessionId}: ${nextExperimentalResume}`);
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                    } else {
                        logger.debug('[Codex] No resume file found for previous session');
                    }
                } catch (e) {
                    logger.debug('[Codex] Error while searching resume file', e);
                }
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                // Reset processors/permissions like end-of-turn cleanup
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                continue;
            }
```

## Extensibility Guide

### Adding a New Agent

To add support for a new agent similar to Codex:

1. **Create Agent Directory**: `cli/src/<agent-name>/`

2. **Create Main Runner**: `run<Agent>.ts`
   - Follow pattern from `runCodex.ts`
   - Create session
   - Setup message queue
   - Handle MCP connection (if applicable)
   - Process messages/events

3. **Create MCP Client** (if MCP-based):
   - `agentMcpClient.ts` - MCP client wrapper
   - Handle connection, tool calls, events

4. **Create Message Processors** (if needed):
   - Process specialized message types
   - Convert to standard format for mobile

5. **Add Command**: Register in `cli/src/index.ts`

### Adding New Message Processors

To add a new message processor:

1. **Create Processor Class**: `utils/<processorName>Processor.ts`

2. **Implement Interface**:
   ```typescript
   export class NewProcessor {
       private onMessage: ((message: any) => void) | null = null;
       
       constructor(onMessage?: (message: any) => void) {
           this.onMessage = onMessage || null;
       }
       
       process(data: any): void {
           // Process data and call onMessage
       }
       
       reset(): void {
           // Reset state
       }
   }
   ```

3. **Register in Main Loop**: Add to event handler in `runCodex.ts`

4. **Handle in Event Handler**: Process specific event types

### Adding New MCP Tools

To add a new tool accessible to Codex:

1. **Add to Vibe MCP Server**: Register in `startVibeServer.ts` (same as Claude Code)

2. **Bridge Automatically Forwards**: STDIO bridge forwards all tools

3. **Update System Prompt**: Instruct Codex to use the tool if needed

### Adding New Event Types

To handle new MCP event types:

1. **Add to Event Handler**: Add case in `client.setHandler()` in `runCodex.ts`

2. **Process Event**: Convert to standard message format

3. **Send to Mobile**: Use `session.sendCodexMessage()`

4. **Update Types**: Add to `types.ts` if needed

## Code Examples

### Starting a Codex Session

```typescript
import { runCodex } from '@/codex/runCodex';
import { readCredentials } from '@/persistence';

const credentials = await readCredentials();
await runCodex({
    credentials,
    startedBy: 'terminal'
});
```

### Handling MCP Events

```typescript
client.setHandler((msg) => {
    switch (msg.type) {
        case 'agent_message':
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
            break;
        // Handle other event types...
    }
});
```

### Sending Messages to Mobile

```typescript
// Send assistant message
session.sendCodexMessage({
    type: 'message',
    message: 'Hello from Codex!',
    id: randomUUID()
});

// Send tool call
session.sendCodexMessage({
    type: 'tool-call',
    name: 'CodexBash',
    callId: randomUUID(),
    input: { command: ['ls', '-la'] },
    id: randomUUID()
});

// Send tool result
session.sendCodexMessage({
    type: 'tool-call-result',
    callId: toolCallId,
    output: { stdout: 'file1.txt\nfile2.txt' },
    id: randomUUID()
});
```

### Creating a Message Processor

```typescript
export class CustomProcessor {
    private onMessage: ((message: any) => void) | null = null;
    
    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
    }
    
    process(data: any): void {
        // Process data
        const message = {
            type: 'custom',
            data: data,
            id: randomUUID()
        };
        this.onMessage?.(message);
    }
    
    reset(): void {
        // Reset state
    }
}
```

## Summary

This document has covered:

- **Architecture**: MCP-based integration via stdio
- **Integration Method**: Single method using MCP protocol
- **Key Components**: Main files and their responsibilities
- **Message Flow**: Complete data flow from input to mobile
- **Session Management**: Creation, detection, resume, lifecycle
- **Permission System**: Elicitation-based approval flow
- **MCP Integration**: STDIO bridge for Vibe tools
- **Message Processing**: Reasoning, diff, and other processors
- **Error Handling**: Abort, cleanup, mode changes
- **Extensibility**: Patterns for adding new features

For questions or contributions, refer to the main project documentation in `AGENTS.md`.




