/**
 * Cursor CLI Client
 * 
 * Handles communication with Cursor CLI (cursor-agent) via process spawning.
 * This is a separate implementation from Claude, Codex, and Gemini to maintain separation of concerns.
 * 
 * Cursor CLI (cursor-agent) supports:
 * - Interactive mode for conversational sessions
 * - Non-interactive mode with -p flag for automation
 * - MCP server configuration
 * - Model selection
 * - Output format options
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { logger } from '@/ui/logger';
import type { CursorSessionConfig, CursorToolResponse } from './types';
import { execSync } from 'node:child_process';

/**
 * Get the path to cursor-agent executable (cross-platform)
 */
function getCursorAgentPath(): string | null {
    const candidates: string[] = [];

    const pushCandidate = (path: string | undefined | null) => {
        if (path && !candidates.includes(path)) {
            candidates.push(path);
        }
    };

    const commandWorks = () => {
        try {
            execSync('cursor-agent --version', {
                encoding: 'utf-8',
                stdio: 'ignore',
                timeout: 2000
            });
            return true;
        } catch {
            return false;
        }
    };

    if (process.platform === 'win32') {
        const runWhere = (cmd: string): string[] => {
            try {
                const output = execSync(`where ${cmd}`, {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 2000
                });
                return output
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter((line) => line && !line.toLowerCase().startsWith('info:'));
            } catch {
                return [];
            }
        };

        ['cursor-agent.cmd', 'cursor-agent.bat', 'cursor-agent.exe', 'cursor-agent'].forEach((cmd) => {
            runWhere(cmd).forEach((resolved) => pushCandidate(resolvePath(resolved)));
        });

        // Check common Windows installation paths
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) {
            pushCandidate(resolvePath(`${localAppData}\\Programs\\cursor-agent\\cursor-agent.exe`));
        }
        const userProfile = process.env.USERPROFILE;
        if (userProfile) {
            pushCandidate(resolvePath(`${userProfile}\\.local\\bin\\cursor-agent.exe`));
            pushCandidate(resolvePath(`${userProfile}\\.local\\bin\\cursor-agent`));
        }
    } else {
        // Unix-like systems (macOS, Linux)
        pushCandidate('/usr/local/bin/cursor-agent');
        pushCandidate('/usr/bin/cursor-agent');
        pushCandidate(`${process.env.HOME}/.local/bin/cursor-agent`);
        pushCandidate(`${process.env.HOME}/.cursor/bin/cursor-agent`);
        if (process.env.npm_config_prefix) {
            pushCandidate(`${process.env.npm_config_prefix}/bin/cursor-agent`);
        }
    }

    for (const candidate of candidates) {
        try {
            if (candidate && existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // continue
        }
    }

    return commandWorks() ? 'cursor-agent' : null;
}

export class CursorClient {
    private process: ChildProcessWithoutNullStreams | null = null;
    private sessionId: string | null = null;
    private conversationId: string | null = null;
    private connected: boolean = false;
    private handler: ((event: any) => void) | null = null;
    private currentAbortSignal: AbortSignal | null = null;
    private stdoutReader: ReturnType<typeof createInterface> | null = null;

    constructor() {
        // Initialize Cursor client
    }

    /**
     * Set event handler for Cursor messages
     */
    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    /**
     * Connect to Cursor CLI (no-op for process spawning, session starts on first startSession call)
     */
    async connect(): Promise<void> {
        if (this.connected) return;
        this.connected = true;
        logger.debug('[Cursor] Client ready (will spawn process on first session)');
    }

    /**
     * Start a new Cursor session by spawning cursor-agent process
     */
    async startSession(config: CursorSessionConfig, options?: { signal?: AbortSignal }): Promise<CursorToolResponse> {
        if (!this.connected) await this.connect();

        // Kill existing process if any
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }

        logger.debug('[Cursor] Starting session:', config);

        const cursorPath = getCursorAgentPath();
        if (!cursorPath) {
            throw new Error('Cursor CLI (cursor-agent) not found. Please install it: curl https://cursor.com/install -fsS | bash');
        }

        // Build cursor-agent arguments
        const args: string[] = [];

        // Determine if we're in interactive mode
        // Interactive = TTY available AND no prompt provided (user will type interactively)
        const isInteractive = process.stdin.isTTY && process.stdout.isTTY && !config.prompt;

        if (isInteractive) {
            // Interactive mode: inherit stdio, no -p flag
            // User will see cursor-agent output directly in terminal
            logger.debug('[Cursor] Starting in interactive mode - output will be shown in terminal');
        } else {
            // Non-interactive mode: use output format for parsing
            if (config.outputFormat) {
                args.push('--output-format', config.outputFormat);
            }

            // Add prompt if provided
            if (config.prompt) {
                args.push('-p', config.prompt);
            }
        }

        // Add model if specified
        if (config.model) {
            args.push('--model', config.model);
        }

        // Add MCP servers if configured
        // Cursor CLI uses mcp.json in project root, but we can try passing config directly
        if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
            // Cursor CLI may use different flag names - try common patterns
            // For now, we'll set MCP config via environment variable if CLI doesn't support direct flag
            args.push('--mcp-config', JSON.stringify({ mcpServers: config.mcpServers }));
        }

        // Set working directory
        const cwd = config.cwd || process.cwd();

        // Store abort signal
        this.currentAbortSignal = options?.signal || null;

        // Spawn cursor-agent process
        // For interactive mode, inherit stdio so user sees output in terminal
        // For non-interactive mode, pipe stdout to parse JSON/text
        const stdioConfig: ('inherit' | 'pipe')[] = isInteractive
            ? ['inherit', 'inherit', 'inherit'] // Interactive: show output in terminal
            : ['pipe', 'pipe', 'pipe']; // Non-interactive: pipe for parsing

        logger.debug(`[Cursor] Spawning: ${cursorPath} ${args.join(' ')} (interactive: ${isInteractive})`);

        // Spawn options
        const spawnOptions: any = {
            cwd,
            stdio: stdioConfig,
            signal: this.currentAbortSignal || undefined,
            env: {
                ...process.env
            }
        };

        // On Windows, if the path is just a command name (not a full path),
        // we need shell: true for spawn to work properly
        if (process.platform === 'win32') {
            const isFullPath = cursorPath.includes('\\') || cursorPath.includes('/') || cursorPath.includes(':');
            if (!isFullPath) {
                spawnOptions.shell = true;
            }
        }

        this.process = spawn(cursorPath, args, spawnOptions) as ChildProcessWithoutNullStreams;

        // Setup stdout reader for output (only if not interactive)
        if (!isInteractive && this.process.stdout) {
            this.stdoutReader = createInterface({
                input: this.process.stdout,
                crlfDelay: Infinity
            });

            // Process each line of output
            this.stdoutReader.on('line', (line) => {
                this.processOutputLine(line);
            });
        } else if (isInteractive) {
            logger.debug('[Cursor] Running in interactive mode - output will be shown in terminal');
        }

        // Handle stderr
        if (this.process.stderr) {
            this.process.stderr.on('data', (data) => {
                const text = data.toString();
                if (process.env.DEBUG) {
                    logger.debug(`[Cursor] stderr: ${text}`);
                }
                // Send error messages to handler
                this.handler?.({
                    type: 'error',
                    message: text,
                    timestamp: Date.now()
                });
            });
        }

        // Handle process exit
        this.process.on('exit', (code, signal) => {
            logger.debug(`[Cursor] Process exited: code=${code}, signal=${signal}`);
            if (this.stdoutReader) {
                this.stdoutReader.close();
                this.stdoutReader = null;
            }
            this.process = null;

            // Notify handler of completion
            this.handler?.({
                type: 'done',
                exitCode: code,
                signal: signal,
                timestamp: Date.now()
            });
        });

        // Handle process errors
        this.process.on('error', (error) => {
            logger.debug(`[Cursor] Process error:`, error);
            this.handler?.({
                type: 'error',
                message: error.message,
                timestamp: Date.now()
            });
        });

        const response: CursorToolResponse = {
            content: [],
            isError: false
        };

        // Extract session/conversation IDs if present in initial response
        this.extractIdentifiers(response);

        return response;
    }

    /**
     * Process a line of output from cursor-agent
     */
    private processOutputLine(line: string): void {
        // Try to parse as JSON first
        try {
            const message = JSON.parse(line);
            this.handleMessage(message);
            return;
        } catch {
            // Not JSON, might be text output
        }

        // Handle text output
        if (line.trim()) {
            // Detect message type from text patterns
            if (line.startsWith('Error:') || line.startsWith('error:')) {
                this.handler?.({
                    type: 'error',
                    message: line,
                    timestamp: Date.now()
                });
            } else if (line.startsWith('Thinking...') || line.includes('[thinking]')) {
                this.handler?.({
                    type: 'thinking',
                    message: line,
                    timestamp: Date.now()
                });
            } else {
                // Generic text message
                this.handler?.({
                    type: 'message',
                    message: line,
                    timestamp: Date.now()
                });
            }
        }
    }

    /**
     * Continue an existing Cursor session by sending a new prompt
     */
    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CursorToolResponse> {
        if (!this.process || !this.process.stdin) {
            // No active process - start a new session with the prompt
            return this.startSession({
                prompt,
                cwd: process.cwd(),
                mcpServers: undefined
            }, options);
        }

        logger.debug('[Cursor] Continuing session with prompt:', prompt);

        // Try to send prompt to stdin for interactive continuation
        try {
            this.process.stdin.write(prompt + '\n');
            return {
                content: [],
                isError: false
            };
        } catch (error) {
            // If stdin write fails, start a new session
            logger.debug('[Cursor] Failed to write to stdin, starting new session');
            return this.startSession({
                prompt,
                cwd: process.cwd(),
                mcpServers: undefined
            }, options);
        }
    }

    /**
     * Handle incoming messages from cursor-agent
     */
    private handleMessage(message: any): void {
        logger.debug(`[Cursor] Received message:`, message);

        // Extract session/conversation IDs from message
        this.updateIdentifiersFromMessage(message);

        // Forward to handler
        if (this.handler) {
            this.handler(message);
        }
    }

    /**
     * Update identifiers from message
     */
    private updateIdentifiersFromMessage(message: any): void {
        if (!message || typeof message !== 'object') {
            return;
        }

        // Check various possible fields for session/conversation IDs
        const sessionId = message.sessionId || message.session_id || message.session?.id;
        if (sessionId && !this.sessionId) {
            this.sessionId = sessionId;
            logger.debug('[Cursor] Session ID extracted from message:', this.sessionId);
        }

        const conversationId = message.conversationId || message.conversation_id || message.conversation?.id;
        if (conversationId && !this.conversationId) {
            this.conversationId = conversationId;
            logger.debug('[Cursor] Conversation ID extracted from message:', this.conversationId);
        }
    }

    /**
     * Extract session and conversation identifiers from response
     */
    private extractIdentifiers(response: any): void {
        const meta = response?.meta || {};
        if (meta.sessionId) {
            this.sessionId = meta.sessionId;
            logger.debug('[Cursor] Session ID extracted:', this.sessionId);
        } else if (response?.sessionId) {
            this.sessionId = response.sessionId;
            logger.debug('[Cursor] Session ID extracted:', this.sessionId);
        }

        if (meta.conversationId) {
            this.conversationId = meta.conversationId;
            logger.debug('[Cursor] Conversation ID extracted:', this.conversationId);
        } else if (response?.conversationId) {
            this.conversationId = response.conversationId;
            logger.debug('[Cursor] Conversation ID extracted:', this.conversationId);
        }
    }

    /**
     * Get current session ID
     */
    getSessionId(): string | null {
        return this.sessionId;
    }

    /**
     * Check if there's an active session
     */
    hasActiveSession(): boolean {
        return this.process !== null && !this.process.killed;
    }

    /**
     * Clear current session
     */
    clearSession(): void {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
        if (this.stdoutReader) {
            this.stdoutReader.close();
            this.stdoutReader = null;
        }
        this.sessionId = null;
        this.conversationId = null;
        logger.debug('[Cursor] Session cleared');
    }

    /**
     * Store session for resume (if supported)
     */
    storeSessionForResume(): string | null {
        // TODO: Implement session storage for resume if cursor-agent supports it
        return this.sessionId;
    }

    /**
     * Disconnect from cursor-agent
     */
    async disconnect(): Promise<void> {
        this.clearSession();
        this.connected = false;
        logger.debug('[Cursor] Disconnected from cursor-agent');
    }
}




