# Claude Code Integration Documentation

## Introduction

This document explains how Vibe-on-the-Go integrates with Claude Code, covering the architecture, message flow, mode switching, permissions, and extensibility patterns. This serves as a reference for understanding the current implementation and for adding support for new agents in the future.

## Architecture Overview

Vibe-on-the-Go integrates with Claude Code through a **dual-mode system**:

1. **Local/Interactive Mode**: Direct terminal interaction with Claude Code via process spawning
2. **Remote Mode**: Programmatic control via Claude Code SDK for mobile app control

The system automatically switches between these modes based on user control state, allowing seamless transitions between terminal and mobile control.

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
│   Mode Switch   │ (Local ↔ Remote)
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────┐
│ Local  │ │  Remote  │
│ Mode   │ │   Mode   │
└───┬────┘ └────┬──────┘
    │           │
    ▼           ▼
┌─────────────────┐
│  Claude Code    │
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

### Local Mode

Local mode spawns Claude Code as a subprocess and watches session files to detect the session ID. This allows direct terminal interaction while still syncing state to the mobile app.

**Key Characteristics:**
- Spawns `claude` CLI process with `--output-format stream-json`
- Watches `.claude/sessions/` directory for new `.jsonl` files
- Uses file descriptor 3 (fd3) for custom communication
- Tracks thinking state via fetch start/end events
- Direct stdin/stdout interaction

**Implementation**: [`cli/src/claude/claudeLocal.ts`](cli/src/claude/claudeLocal.ts)

### Remote Mode

Remote mode uses the Claude Code SDK to programmatically control Claude Code. This enables mobile app control without requiring terminal interaction.

**Key Characteristics:**
- Uses Claude Code SDK's `query()` function
- Streams messages via async iterable
- Handles tool permission requests via control protocol
- Supports session resume and continuation
- No terminal UI - all output goes to mobile app

**Implementation**: [`cli/src/claude/claudeRemote.ts`](cli/src/claude/claudeRemote.ts)

## Key Components

### 1. `runClaude.ts` - Main Entry Point

**Location**: [`cli/src/claude/runClaude.ts`](cli/src/claude/runClaude.ts)

This is the main entry point for Claude Code sessions. It handles:

- Session creation and initialization
- Message queue setup
- Vibe MCP server startup
- Signal handlers and cleanup
- Metadata extraction (tools, slash commands)

**Key Responsibilities:**

```36:91:cli/src/claude/runClaude.ts
export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    // Log environment info at startup
    logger.debugLargeJson('[START] Vibe process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${options.startedBy}, startingMode=${options.startingMode}`);

    // Validate daemon spawn requirements
    if (options.startedBy === 'daemon' && options.startingMode === 'local') {
        logger.debug('Daemon spawn requested with local mode - forcing remote mode');
        options.startingMode = 'remote';
        // TODO: Eventually we should error here instead of silently switching
        // throw new Error('Daemon-spawned sessions cannot use local/interactive mode');
    }

    // Create session service
    const api = await ApiClient.create(credentials);

    // Create a new session
    let state: AgentState = {};

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexepcted since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/your-username/vibe-on-the-go/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    // Create machine if it doesn't exist
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        vibeHomeDir: configuration.vibeHomeDir,
        vibeLibDir: projectPath(),
        vibeToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude'
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    logger.debug(`Session created: ${response.id}`);
```

**Message Queue Setup:**

```147:291:cli/src/claude/runClaude.ts
    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
        isPlan: mode.permissionMode === 'plan',
        model: mode.model,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools
    }));

    // Forward messages to the queue
    let currentPermissionMode = options.permissionMode;
    let currentModel = options.model; // Track current model state
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
    let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools
    session.onUserMessage((message) => {

        // Resolve permission mode from meta
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);

            } else {
                logger.debug(`[loop] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Resolve model - use message.meta.model if provided, otherwise use current model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined; // null becomes undefined
            currentModel = messageModel;
            logger.debug(`[loop] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[loop] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${messageAppendSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'none'}`);
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        // Push with resolved permission mode, model, system prompts, and tools
        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            fallbackModel: messageFallbackModel,
            customSystemPrompt: messageCustomSystemPrompt,
            appendSystemPrompt: messageAppendSystemPrompt,
            allowedTools: messageAllowedTools,
            disallowedTools: messageDisallowedTools
        };
        messageQueue.push(message.content.text, enhancedMode);
        logger.debugLargeJson('User message pushed to queue:', message)
    });
```

### 2. `loop.ts` - Mode Switching Logic

**Location**: [`cli/src/claude/loop.ts`](cli/src/claude/loop.ts)

The loop manages mode switching between local and remote modes:

```37:94:cli/src/claude/loop.ts
export async function loop(opts: LoopOptions) {

    // Get log path for debug display
    const logPath = logger.logFilePath;
    let session = new Session({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: null,
        claudeEnvVars: opts.claudeEnvVars,
        claudeArgs: opts.claudeArgs,
        mcpServers: opts.mcpServers,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        allowedTools: opts.allowedTools,
        onModeChange: opts.onModeChange
    });

    // Notify that session is ready
    if (opts.onSessionReady) {
        opts.onSessionReady(session);
    }

    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    while (true) {
        logger.debug(`[loop] Iteration with mode: ${mode}`);

        // Run local mode if applicable
        if (mode === 'local') {
            let reason = await claudeLocalLauncher(session);
            if (reason === 'exit') { // Normal exit - Exit loop
                return;
            }

            // Non "exit" reason means we need to switch to remote mode
            mode = 'remote';
            if (opts.onModeChange) {
                opts.onModeChange(mode);
            }
            continue;
        }

        // Start remote mode
        if (mode === 'remote') {
            let reason = await claudeRemoteLauncher(session);
            if (reason === 'exit') { // Normal exit - Exit loop
                return;
            }

            // Non "exit" reason means we need to switch to local mode
            mode = 'local';
            if (opts.onModeChange) {
                opts.onModeChange(mode);
            }
            continue;
        }
    }
}
```

**Mode Switching Triggers:**
- **Local → Remote**: When user sends message from mobile app
- **Remote → Local**: When user presses Ctrl+C in terminal (interrupts remote mode)

### 3. `claudeLocal.ts` - Local Mode Implementation

**Location**: [`cli/src/claude/claudeLocal.ts`](cli/src/claude/claudeLocal.ts)

Handles process spawning and file watching:

```16:219:cli/src/claude/claudeLocal.ts
export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    mcpServers?: Record<string, any>,
    path: string,
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[]
    allowedTools?: string[]
}) {

    // Start a watcher for to detect the session id
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });
    const watcher = watch(projectDir);
    let resolvedSessionId: string | null = null;
    const detectedIdsRandomUUID = new Set<string>();
    const detectedIdsFileSystem = new Set<string>();
    watcher.on('change', (event, filename) => {
        if (typeof filename === 'string' && filename.toLowerCase().endsWith('.jsonl')) {
            logger.debug('change', event, filename);
            const sessionId = filename.replace('.jsonl', '');
            if (detectedIdsFileSystem.has(sessionId)) {
                return;
            }
            detectedIdsFileSystem.add(sessionId);

            // Try to match
            if (resolvedSessionId) {
                return;
            }

            // Try to match with random UUID
            if (detectedIdsRandomUUID.has(sessionId)) {
                resolvedSessionId = sessionId;
                opts.onSessionFound(sessionId);
            }
        }
    });

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    // Thinking state
    let thinking = false;
    let stopThinkingTimeout: NodeJS.Timeout | null = null;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[ClaudeLocal] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Spawn the process
    try {
        // Start the interactive process
        process.stdin.pause();
        await new Promise<void>((r, reject) => {
            const args: string[] = []
            if (startFrom) {
                args.push('--resume', startFrom)
            }
            args.push('--append-system-prompt', systemPrompt);

            if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
                args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
            }

            if (opts.allowedTools && opts.allowedTools.length > 0) {
                args.push('--allowedTools', opts.allowedTools.join(','));
            }

            // Add custom Claude arguments
            if (opts.claudeArgs) {
                args.push(...opts.claudeArgs)
            }

            if (!claudeCliPath || !existsSync(claudeCliPath)) {
                throw new Error('Claude local launcher not found. Please ensure VIBE_PROJECT_ROOT is set correctly for development.');
            }

            // Prepare environment variables
            const env = {
                ...process.env,
                ...opts.claudeEnvVars
            }

            const child = spawn('node', [claudeCliPath, ...args], {
                stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
                signal: opts.abort,
                cwd: opts.path,
                env,
            });

            // Listen to the custom fd (fd 3) line by line
            if (child.stdio[3]) {
                const rl = createInterface({
                    input: child.stdio[3] as any,
                    crlfDelay: Infinity
                });

                // Track active fetches for thinking state
                const activeFetches = new Map<number, { hostname: string, path: string, startTime: number }>();

                rl.on('line', (line) => {
                    try {
                        // Try to parse as JSON
                        const message = JSON.parse(line);

                        switch (message.type) {
                            case 'uuid':
                                detectedIdsRandomUUID.add(message.value);

                                if (!resolvedSessionId && detectedIdsFileSystem.has(message.value)) {
                                    resolvedSessionId = message.value;
                                    opts.onSessionFound(message.value);
                                }
                                break;

                            case 'fetch-start':
                                // logger.debug(`[ClaudeLocal] Fetch start: ${message.method} ${message.hostname}${message.path} (id: ${message.id})`);
                                activeFetches.set(message.id, {
                                    hostname: message.hostname,
                                    path: message.path,
                                    startTime: message.timestamp
                                });

                                // Clear any pending stop timeout
                                if (stopThinkingTimeout) {
                                    clearTimeout(stopThinkingTimeout);
                                    stopThinkingTimeout = null;
                                }

                                // Start thinking
                                updateThinking(true);
                                break;

                            case 'fetch-end':
                                // logger.debug(`[ClaudeLocal] Fetch end: id ${message.id}`);
                                activeFetches.delete(message.id);

                                // Stop thinking when no active fetches
                                if (activeFetches.size === 0 && thinking && !stopThinkingTimeout) {
                                    stopThinkingTimeout = setTimeout(() => {
                                        if (activeFetches.size === 0) {
                                            updateThinking(false);
                                        }
                                        stopThinkingTimeout = null;
                                    }, 500); // Small delay to avoid flickering
                                }
                                break;

                            default:
                                logger.debug(`[ClaudeLocal] Unknown message type: ${message.type}`);
                        }
                    } catch (e) {
                        // Not JSON, ignore (could be other output)
                        logger.debug(`[ClaudeLocal] Non-JSON line from fd3: ${line}`);
                    }
                });

                rl.on('error', (err) => {
                    console.error('Error reading from fd 3:', err);
                });

                // Cleanup on child exit
                child.on('exit', () => {
                    if (stopThinkingTimeout) {
                        clearTimeout(stopThinkingTimeout);
                    }
                    updateThinking(false);
                });
            }
            child.on('error', (error) => {
                // Ignore
            });
            child.on('exit', (code, signal) => {
                if (signal === 'SIGTERM' && opts.abort.aborted) {
                    // Normal termination due to abort signal
                    r();
                } else if (signal) {
                    reject(new Error(`Process terminated with signal: ${signal}`));
                } else {
                    r();
                }
            });
        });
    } finally {
        watcher.close();
        process.stdin.resume();
        if (stopThinkingTimeout) {
            clearTimeout(stopThinkingTimeout);
            stopThinkingTimeout = null;
        }
        updateThinking(false);
    }

    //
    // Double check that session is correct
    //

    return resolvedSessionId;
}
```

**Key Features:**
- File system watcher detects new session files
- UUID detection via fd3 communication
- Thinking state tracking via fetch events
- Process lifecycle management

### 4. `claudeRemote.ts` - Remote Mode Implementation

**Location**: [`cli/src/claude/claudeRemote.ts`](cli/src/claude/claudeRemote.ts)

Uses Claude Code SDK for programmatic control:

```14:234:cli/src/claude/claudeRemote.ts
export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: initial.mode.permissionMode === 'plan' ? 'plan' : 'default',
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        executable: 'node',
        abort: opts.signal,
        pathToClaudeCodeExecutable: (() => {
            return resolve(join(projectPath(), 'scripts', 'claude_remote_launcher.cjs'));
        })(),
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initial.message,
        },
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    updateThinking(true);
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            // Handle messages
            opts.onMessage(message);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received, exiting claudeRemote');

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Send ready event
                opts.onReady();

                // Push next message
                const next = await opts.nextMessage();
                if (!next) {
                    messages.end();
                    return;
                }
                mode = next.mode;
                messages.push({ type: 'user', message: { role: 'user', content: next.message } });
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        updateThinking(false);
    }
}
```

**Key Features:**
- Async iterable message streaming
- Session ID detection from system init message
- Tool permission handling via `canCallTool` callback
- Message continuation support
- Abort handling

### 5. `sdk/query.ts` - SDK Wrapper

**Location**: [`cli/src/claude/sdk/query.ts`](cli/src/claude/sdk/query.ts)

Wraps Claude Code SDK's query function and handles process spawning:

```253:401:cli/src/claude/sdk/query.ts
export function query(config: {
    prompt: QueryPrompt
    options?: QueryOptions
}): Query {
    const {
        prompt,
        options: {
            allowedTools = [],
            appendSystemPrompt,
            customSystemPrompt,
            cwd,
            disallowedTools = [],
            executable = 'node',
            executableArgs = [],
            maxTurns,
            mcpServers,
            pathToClaudeCodeExecutable = getDefaultClaudeCodePath(),
            permissionMode = 'default',
            continue: continueConversation,
            resume,
            model,
            fallbackModel,
            strictMcpConfig,
            canCallTool
        } = {}
    } = config

    // Set entrypoint if not already set
    if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
        process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    }

    // Build command arguments
    const args = ['--output-format', 'stream-json', '--verbose']

    if (customSystemPrompt) args.push('--system-prompt', customSystemPrompt)
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt)
    if (maxTurns) args.push('--max-turns', maxTurns.toString())
    if (model) args.push('--model', model)
    if (canCallTool) {
        if (typeof prompt === 'string') {
            throw new Error('canCallTool callback requires --input-format stream-json. Please set prompt as an AsyncIterable.')
        }
        args.push('--permission-prompt-tool', 'stdio')
    }
    if (continueConversation) args.push('--continue')
    if (resume) args.push('--resume', resume)
    if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','))
    if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','))
    if (mcpServers && Object.keys(mcpServers).length > 0) {
        args.push('--mcp-config', JSON.stringify({ mcpServers }))
    }
    if (strictMcpConfig) args.push('--strict-mcp-config')
    if (permissionMode) args.push('--permission-mode', permissionMode)

    if (fallbackModel) {
        if (model && fallbackModel === model) {
            throw new Error('Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.')
        }
        args.push('--fallback-model', fallbackModel)
    }

    // Handle prompt input
    if (typeof prompt === 'string') {
        args.push('--print', prompt.trim())
    } else {
        args.push('--input-format', 'stream-json')
    }

    // Validate executable path
    if (!existsSync(pathToClaudeCodeExecutable)) {
        throw new ReferenceError(`Claude Code executable not found at ${pathToClaudeCodeExecutable}. Is options.pathToClaudeCodeExecutable set?`)
    }

    // Spawn Claude Code process
    logDebug(`Spawning Claude Code process: ${executable} ${[...executableArgs, pathToClaudeCodeExecutable, ...args].join(' ')}`)

    const child = spawn(executable, [...executableArgs, pathToClaudeCodeExecutable, ...args], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: config.options?.abort,
        env: {
            ...process.env
        }
    }) as ChildProcessWithoutNullStreams

    // Handle stdin
    let childStdin: Writable | null = null
    if (typeof prompt === 'string') {
        child.stdin.end()
    } else {
        streamToStdin(prompt, child.stdin, config.options?.abort)
        childStdin = child.stdin
    }

    // Handle stderr in debug mode
    if (process.env.DEBUG) {
        child.stderr.on('data', (data) => {
            console.error('Claude Code stderr:', data.toString())
        })
    }

    // Setup cleanup
    const cleanup = () => {
        if (!child.killed) {
            child.kill('SIGTERM')
        }
    }

    config.options?.abort?.addEventListener('abort', cleanup)
    process.on('exit', cleanup)

    // Handle process exit
    const processExitPromise = new Promise<void>((resolve) => {
        child.on('close', (code) => {
            if (config.options?.abort?.aborted) {
                query.setError(new AbortError('Claude Code process aborted by user'))
            }
            if (code !== 0) {
                query.setError(new Error(`Claude Code process exited with code ${code}`))
            } else {
                resolve()
            }
        })
    })

    // Create query instance
    const query = new Query(childStdin, child.stdout, processExitPromise, canCallTool)

    // Handle process errors
    child.on('error', (error) => {
        if (config.options?.abort?.aborted) {
            query.setError(new AbortError('Claude Code process aborted by user'))
        } else {
            query.setError(new Error(`Failed to spawn Claude Code process: ${error.message}`))
        }
    })

    // Cleanup on exit
    processExitPromise.finally(() => {
        cleanup()
        config.options?.abort?.removeEventListener('abort', cleanup)
        if (process.env.CLAUDE_SDK_MCP_SERVERS) {
            delete process.env.CLAUDE_SDK_MCP_SERVERS
        }
    })

    return query
}
```

**Key Features:**
- Process spawning with proper argument construction
- Control protocol handling for tool permissions
- Stream-based message processing
- Abort signal support

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
│   loop.ts            │
│   (mode switch)      │
└──────────┬───────────┘
           │
    ┌──────┴──────┐
    ▼            ▼
┌─────────┐  ┌──────────┐
│ Local   │  │  Remote   │
│ Mode    │  │   Mode   │
└────┬────┘  └─────┬─────┘
     │            │
     ▼            ▼
┌──────────────────────┐
│   Claude Code        │
│   (Process/SDK)      │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   SDK Messages       │
│   (tool calls, etc)  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Permission Handler │
│   (if needed)       │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Session Client     │
│   sendClaudeMessage()│
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

Claude Code integration handles several message types:

1. **User Messages**: Text input from user
2. **Assistant Messages**: Text responses from Claude
3. **Tool Calls**: Requests to execute tools (Read, Write, Bash, etc.)
4. **Tool Results**: Results from tool execution
5. **System Messages**: Session initialization, errors, etc.
6. **Control Messages**: Permission requests, interrupts

### Encryption Flow

All messages are encrypted before transmission:

```typescript
// Encryption happens in ApiSessionClient
const encrypted = encrypt(encryptionKey, variant, messageData);
const encoded = encodeBase64(encrypted);
// Send via WebSocket
```

The server stores encrypted blobs but cannot decrypt them (zero-knowledge architecture).

## Session Management

### Session Creation

Sessions are created in `runClaude.ts`:

```73:92:cli/src/claude/runClaude.ts
    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        vibeHomeDir: configuration.vibeHomeDir,
        vibeLibDir: projectPath(),
        vibeToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude'
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    logger.debug(`Session created: ${response.id}`);
```

### Session ID Detection

**Local Mode**: Detected via file system watcher and UUID messages:

```35:54:cli/src/claude/claudeLocal.ts
    watcher.on('change', (event, filename) => {
        if (typeof filename === 'string' && filename.toLowerCase().endsWith('.jsonl')) {
            logger.debug('change', event, filename);
            const sessionId = filename.replace('.jsonl', '');
            if (detectedIdsFileSystem.has(sessionId)) {
                return;
            }
            detectedIdsFileSystem.add(sessionId);

            // Try to match
            if (resolvedSessionId) {
                return;
            }

            // Try to match with random UUID
            if (detectedIdsRandomUUID.has(sessionId)) {
                resolvedSessionId = sessionId;
                opts.onSessionFound(sessionId);
            }
        }
    });
```

**Remote Mode**: Detected from system init message:

```168:182:cli/src/claude/claudeRemote.ts
            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }
```

### Session Resume

Sessions can be resumed by passing the session ID:

- **Local Mode**: `--resume <sessionId>` argument
- **Remote Mode**: `resume` option in SDK query

The session ID is validated before use:

```58:61:cli/src/claude/claudeLocal.ts
    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
```

### Session Lifecycle

Sessions have lifecycle states tracked in metadata:

- `running`: Active session
- `archived`: Session terminated

Lifecycle updates are sent on cleanup:

```299:306:cli/src/claude/runClaude.ts
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

When Claude Code wants to use a tool, it sends a control request:

1. **Control Request**: Claude sends `control_request` with `can_use_tool` subtype
2. **Permission Handler**: Intercepts the request
3. **Mobile Request**: Sends permission request to mobile app via RPC
4. **User Decision**: User approves/denies on mobile
5. **Response**: Permission result sent back to Claude Code
6. **Tool Execution**: If approved, tool executes

**Implementation**: [`cli/src/claude/utils/permissionHandler.ts`](cli/src/claude/utils/permissionHandler.ts)

### Permission Modes

Claude Code supports different permission modes:

- `default`: Normal permission prompts
- `acceptEdits`: Auto-approve edit operations
- `bypassPermissions`: Auto-approve all tools
- `plan`: Plan mode (no execution)

These are set per message via metadata:

```169:182:cli/src/claude/runClaude.ts
        // Resolve permission mode from meta
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);

            } else {
                logger.debug(`[loop] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }
```

## MCP Integration

### Vibe MCP Server

Vibe provides a custom MCP server that exposes tools to Claude Code:

**Location**: [`cli/src/claude/utils/startVibeServer.ts`](cli/src/claude/utils/startVibeServer.ts)

**Tools Exposed:**
- `change_title`: Change the chat session title

**Implementation:**

```15:114:cli/src/claude/utils/startVibeServer.ts
export async function startVibeServer(client: ApiSessionClient) {
    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[vibeMCP] Changing title to:', title);
        try {
            // Send title as a summary message, similar to title generator
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    //
    // Create the MCP server
    //

    const mcp = new McpServer({
        name: "Vibe MCP",
        version: "1.0.0",
        description: "Vibe CLI MCP server with chat session management tools",
    });

    mcp.registerTool('change_title',
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        logger.debug('[vibeMCP] Response:', response);
        
        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }


    const transport = new StreamableHTTPServerTransport({
        // NOTE: Returning session id here will result in claude
        // sdk spawn to fail with `Invalid Request: Server already initialized`
        sessionIdGenerator: undefined
    });
    await mcp.connect(transport);

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title']
```

**MCP Server Configuration:**

The Vibe MCP server is configured in both modes:

```364:369:cli/src/claude/runClaude.ts
        mcpServers: {
            'vibe': {
                type: 'http' as const,
                url: vibeServer.url,
            }
        },
```

### System Prompt Integration

The system prompt instructs Claude to use the title tool:

```7:9:cli/src/claude/utils/systemPrompt.ts
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__vibe__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`))();
```

## Mode Switching

### Local → Remote

Triggered when:
- User sends message from mobile app
- `controlledByUser` state changes to `false`

**Process:**
1. Local mode detects user message from mobile
2. Exits local mode (returns non-"exit" reason)
3. Loop switches to remote mode
4. Remote mode starts with SDK

### Remote → Local

Triggered when:
- User presses Ctrl+C in terminal
- `controlledByUser` state changes to `true`

**Process:**
1. Remote mode receives interrupt signal
2. Exits remote mode (returns non-"exit" reason)
3. Loop switches to local mode
4. Local mode spawns new process

### Mode State Tracking

Mode changes are tracked and sent to mobile:

```354:359:cli/src/claude/runClaude.ts
        onModeChange: (newMode) => {
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: newMode === 'local'
            }));
        },
```

## Error Handling

### Abort Handling

Both modes support abort signals:

**Local Mode:**
- Process receives SIGTERM
- File watcher closes
- Thinking state resets

**Remote Mode:**
- SDK query receives abort signal
- Process cleanup
- Message stream ends

### Cleanup

Cleanup happens on process exit:

```294:341:cli/src/claude/runClaude.ts
    // Setup signal handlers for graceful shutdown
    const cleanup = async () => {
        logger.debug('[START] Received termination signal, cleaning up...');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Vibe MCP server
            vibeServer.stop();

            logger.debug('[START] Cleanup complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[START] Error during cleanup:', error);
            process.exit(1);
        }
    };

    // Handle termination signals
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Handle uncaught exceptions and rejections
    process.on('uncaughtException', (error) => {
        logger.debug('[START] Uncaught exception:', error);
        cleanup();
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[START] Unhandled rejection:', reason);
        cleanup();
    });
```

## Extensibility Guide

### Adding a New Agent

To add support for a new agent similar to Claude Code:

1. **Create Agent Directory**: `cli/src/<agent-name>/`

2. **Create Main Runner**: `run<Agent>.ts`
   - Follow pattern from `runClaude.ts`
   - Create session
   - Setup message queue
   - Handle cleanup

3. **Create Mode Implementations** (if dual-mode):
   - `agentLocal.ts` - Terminal interaction
   - `agentRemote.ts` - Programmatic control

4. **Create Loop** (if mode switching):
   - `loop.ts` - Mode switching logic

5. **Create Session Wrapper**:
   - `session.ts` - Session state management

6. **Add Command**: Register in `cli/src/index.ts`

### Adding New MCP Tools

To add a new tool to the Vibe MCP server:

1. **Register Tool** in `startVibeServer.ts`:

```typescript
mcp.registerTool('tool_name',
    {
        description: 'Tool description',
        title: 'Tool Title',
        inputSchema: {
            // Zod schema
        },
    },
    async (args) => {
        // Tool implementation
        return { content: [...], isError: false };
    }
);
```

2. **Update Tool Names**:

```typescript
return {
    url: baseUrl.toString(),
    toolNames: ['change_title', 'new_tool']
};
```

3. **Update System Prompt** (if needed) to instruct agent to use the tool

### Adding New Message Types

To handle new message types from Claude Code:

1. **Update SDK Types**: Add to `cli/src/claude/sdk/types.ts`

2. **Handle in Remote Mode**: Add case in `claudeRemote.ts` message loop

3. **Handle in Local Mode**: Add parsing in `claudeLocal.ts` if needed

4. **Send to Mobile**: Use `session.sendClaudeSessionMessage()`

### Adding New Permission Modes

To add a new permission mode:

1. **Update Type**: Add to `PermissionMode` type in `loop.ts`

2. **Handle in Queue**: Update message queue resolution logic

3. **Pass to SDK**: Update SDK options construction

4. **Document**: Update this documentation

## Code Examples

### Starting a Claude Code Session

```typescript
import { runClaude } from '@/claude/runClaude';
import { readCredentials } from '@/persistence';

const credentials = await readCredentials();
await runClaude(credentials, {
    model: 'claude-3-5-sonnet-20241022',
    permissionMode: 'default',
    startingMode: 'local'
});
```

### Handling Tool Permissions

```typescript
const canCallTool = async (
    toolName: string,
    input: unknown,
    mode: EnhancedMode,
    options: { signal: AbortSignal }
): Promise<PermissionResult> => {
    // Request permission from mobile app
    const response = await session.rpcHandlerManager.call('permission', {
        tool: toolName,
        input: input
    });
    
    return {
        decision: response.approved ? 'approved' : 'denied'
    };
};
```

### Sending Messages to Mobile

```typescript
// Send assistant message
session.sendClaudeSessionMessage({
    type: 'message',
    message: 'Hello from Claude!',
    id: randomUUID()
});

// Send tool call
session.sendClaudeSessionMessage({
    type: 'tool-call',
    name: 'Read',
    callId: randomUUID(),
    input: { path: 'file.txt' },
    id: randomUUID()
});

// Send tool result
session.sendClaudeSessionMessage({
    type: 'tool-call-result',
    callId: toolCallId,
    output: { content: 'File contents...' },
    id: randomUUID()
});
```

## Summary

This document has covered:

- **Architecture**: Dual-mode system (local/remote)
- **Integration Methods**: Process spawning vs SDK
- **Key Components**: Main files and their responsibilities
- **Message Flow**: Complete data flow from input to mobile
- **Session Management**: Creation, detection, resume, lifecycle
- **Permission System**: Tool approval flow
- **MCP Integration**: Custom tools and server setup
- **Mode Switching**: Local ↔ remote transitions
- **Error Handling**: Abort, cleanup, recovery
- **Extensibility**: Patterns for adding new features

For questions or contributions, refer to the main project documentation in `AGENTS.md`.




