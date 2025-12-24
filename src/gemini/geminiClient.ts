/**
 * Gemini CLI Client
 * 
 * Handles communication with Gemini CLI process via process spawning.
 * This is a separate implementation from Claude and Codex to maintain separation of concerns.
 * 
 * Gemini CLI supports:
 * - Process spawning with --output-format stream-json
 * - MCP server configuration
 * - Non-interactive mode with -p flag
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { logger } from '@/ui/logger';
import type { GeminiSessionConfig, GeminiToolResponse } from './types';
import { execSync } from 'node:child_process';
import spawn from 'cross-spawn';

/**
 * Get the path to Gemini CLI executable (cross-platform)
 */
function logSpawnDetails(details: {
    geminiPath: string;
    args: string[];
    cwd: string;
    stdio: ('inherit' | 'pipe')[];
    shell?: boolean;
}): void {
    if (!process.env.DEBUG) return;
    logger.debug(
        `[Gemini] spawn config -> path="${details.geminiPath}", cwd="${details.cwd}", stdio="${details.stdio.join(
            ','
        )}", shell=${details.shell ?? false}`
    );
    if (details.args.length > 0) {
        logger.debug(`[Gemini] spawn args -> ${JSON.stringify(details.args)}`);
    }
}

function getGeminiCliPath(): string | null {
    const candidates: string[] = [];

    const pushCandidate = (path: string | undefined | null) => {
        if (path && !candidates.includes(path)) {
            candidates.push(path);
        }
    };

    const commandWorks = () => {
        try {
            execSync('gemini --version', {
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
        const runWhere = (cmd: string, binary: 'where' | 'where.exe'): string[] => {
            try {
                const output = execSync(`${binary} ${cmd}`, {
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

        const whereBinaries: Array<'where' | 'where.exe'> = ['where', 'where.exe'];
        ['gemini.cmd', 'gemini.bat', 'gemini'].forEach((cmd) => {
            whereBinaries.forEach((binary) => {
                runWhere(cmd, binary).forEach((resolved) => pushCandidate(resolvePath(resolved)));
            });
        });

        try {
            const npmPrefix = execSync('npm config get prefix', { encoding: 'utf-8' }).trim();
            pushCandidate(resolvePath(`${npmPrefix}\\gemini.cmd`));
            pushCandidate(resolvePath(`${npmPrefix}\\gemini.bat`));
            pushCandidate(resolvePath(`${npmPrefix}\\node_modules\\.bin\\gemini.cmd`));
        } catch {
            // ignore npm failures
        }

        try {
            const npmBin = execSync('npm bin -g', { encoding: 'utf-8' }).trim();
            pushCandidate(resolvePath(`${npmBin}\\gemini.cmd`));
            pushCandidate(resolvePath(`${npmBin}\\gemini.bat`));
            pushCandidate(resolvePath(`${npmBin}\\gemini`));
        } catch {
            // ignore npm bin failures
        }
    } else {
        pushCandidate('/usr/local/bin/gemini');
        pushCandidate('/usr/bin/gemini');
        pushCandidate(`${process.env.HOME}/.local/bin/gemini`);
        if (process.env.npm_config_prefix) {
            pushCandidate(`${process.env.npm_config_prefix}/bin/gemini`);
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

    return commandWorks() ? 'gemini' : null;
}

function resolveGeminiBinary(): string | null {
    const override = process.env.VIBE_GEMINI_BIN;
    if (override && override.trim().length > 0) {
        const normalized = override.trim();
        logger.debug(`[Gemini] Using VIBE_GEMINI_BIN override: ${normalized}`);
        return normalized;
    }
    return getGeminiCliPath();
}

export class GeminiClient {
    private process: ChildProcess | null = null;
    private sessionId: string | null = null;
    private conversationId: string | null = null;
    private connected: boolean = false;
    private handler: ((event: any) => void) | null = null;
    private currentAbortSignal: AbortSignal | null = null;
    private stdoutReader: ReturnType<typeof createInterface> | null = null;
    private lastSessionConfig: GeminiSessionConfig | null = null;

    constructor() {
        // Initialize Gemini client
    }

    /**
     * Set event handler for Gemini messages
     */
    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    /**
     * Connect to Gemini CLI (no-op for process spawning, session starts on first startSession call)
     */
    async connect(): Promise<void> {
        if (this.connected) return;
        this.connected = true;
        logger.debug('[Gemini] Client ready (will spawn process on first session)');
    }

    /**
     * Start a new Gemini session by spawning Gemini CLI process
     */
    async startSession(config: GeminiSessionConfig, options?: { signal?: AbortSignal }): Promise<GeminiToolResponse> {
        if (!this.connected) await this.connect();

        // Kill existing process if any
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }

        logger.debug('[Gemini] Starting session:', config);

        const geminiPath = resolveGeminiBinary();
        if (!geminiPath) {
            throw new Error('Gemini CLI not found. Please install it: npm install -g @google/gemini-cli');
        }

        // Cache config (without transient prompt) for future continuations
        this.lastSessionConfig = {
            ...config,
            prompt: undefined
        };

        // Build Gemini CLI arguments
        const args: string[] = [];
        
        // Determine if we're in interactive mode (opt-in via env)
        const interactiveEnv = String(process.env.VIBE_GEMINI_INTERACTIVE || '').toLowerCase();
        const forceInteractive = interactiveEnv === '1' || interactiveEnv === 'true' || interactiveEnv === 'yes';
        const isInteractive = forceInteractive && process.stdin.isTTY && process.stdout.isTTY && !config.prompt;
        
        if (isInteractive) {
            logger.debug('[Gemini] Starting in interactive mode - output will be shown in terminal (no mobile sync)');
        }

        // Non-interactive mode: use stream-json for parsing so we can sync with mobile
        if (!isInteractive) {
            args.push('--output-format', 'stream-json');
            if (config.prompt) {
                args.push('-p', config.prompt);
            }
        }

        // Add model if specified
        if (config.model) {
            args.push('-m', config.model);
        }

        // Add MCP servers if configured
        if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
            logger.warn(
                '[Gemini] MCP servers requested but current Gemini CLI build does not accept --mcp-config; please configure MCP via `gemini mcp` commands.'
            );
        }

        // Set working directory
        const cwd = config.cwd || process.cwd();

        // Store abort signal
        this.currentAbortSignal = options?.signal || null;

        // Spawn Gemini CLI process
        // For interactive mode, inherit stdio so user sees output in terminal
        // For non-interactive mode, pipe stdout to parse JSON
        const stdioConfig: ('inherit' | 'pipe')[] = isInteractive 
            ? ['inherit', 'inherit', 'inherit'] // Interactive: show output in terminal
            : ['pipe', 'pipe', 'pipe']; // Non-interactive: pipe for JSON parsing

        logger.debug(`[Gemini] Spawning: ${geminiPath} ${args.join(' ')} (interactive: ${isInteractive})`);

        const spawnOptions: SpawnOptions & { signal?: AbortSignal } = {
            cwd,
            stdio: stdioConfig,
            signal: this.currentAbortSignal || undefined,
            env: {
                ...process.env
            }
        };

        logSpawnDetails({
            geminiPath,
            args,
            cwd,
            stdio: stdioConfig,
            shell: typeof spawnOptions.shell === 'boolean' ? spawnOptions.shell : undefined
        });

        try {
            this.process = spawn(geminiPath, args, spawnOptions);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to start Gemini CLI (${message}). Tried path: ${geminiPath}`);
        }

        // Setup stdout reader for stream-json output (only if not interactive)
        if (!isInteractive && this.process.stdout) {
            this.stdoutReader = createInterface({
                input: this.process.stdout,
                crlfDelay: Infinity
            });

            // Process each line of JSON output
            this.stdoutReader.on('line', (line) => {
                try {
                    const message = JSON.parse(line);
                    this.handleMessage(message);
                } catch (e) {
                    // Not JSON, might be other output - log in debug mode
                    if (process.env.DEBUG) {
                        logger.debug(`[Gemini] Non-JSON line: ${line}`);
                    }
                }
            });
        } else if (isInteractive) {
            // In interactive mode, we can't parse JSON from stdout since it's inherited
            // Instead, we'll need to detect session ID from other means or use a different approach
            // For now, we'll just let Gemini CLI run normally and the user will see output
            logger.debug('[Gemini] Running in interactive mode - output will be shown in terminal');
        }

        // Handle stderr
        if (this.process.stderr) {
            let stderrBuffer = '';
            
            this.process.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderrBuffer += chunk;
                
                // Process complete lines
                const lines = stderrBuffer.split(/\r?\n/);
                stderrBuffer = lines.pop() || ''; // Keep incomplete line in buffer
                
                for (const text of lines) {
                    const trimmed = text.trim();
                    if (!trimmed) continue;
                    
                    if (process.env.DEBUG) {
                        logger.debug(`[Gemini] stderr: ${trimmed}`);
                    }
                    
                    // Only forward actual errors to handler, not debug/info output
                    // Debug output from Gemini CLI typically starts with [DEBUG], [INFO], etc.
                    const isDebugOutput = /^\[?(DEBUG|INFO|TRACE|WARN)\]?\s/i.test(trimmed) ||
                        trimmed.includes('[MemoryDiscovery]') ||
                        trimmed.includes('[BfsFileSearch]') ||
                        trimmed.includes('[AgentRegistry]') ||
                        trimmed.includes('Scanning [') ||
                        trimmed.includes('batch of') ||
                        trimmed.includes('Experiments loaded') ||
                        trimmed.includes('experimentIds') ||
                        trimmed.includes('flagId') ||
                        trimmed.includes('Session ID:') ||
                        trimmed.includes('Flushing log events') ||
                        trimmed.includes('Clearcut') ||
                        trimmed.includes('cached credentials') ||
                        trimmed.startsWith('Loading') ||
                        trimmed.startsWith('Loaded') ||
                        trimmed.startsWith('Found readable') ||
                        trimmed.startsWith('Searching for') ||
                        trimmed.startsWith('Determined project') ||
                        /^\s*[\[\{]/.test(trimmed) || // Lines starting with [ or { (JSON fragments)
                        /^\s*\d+,$/.test(trimmed) ||  // Lines that are just numbers (array elements)
                        /^\s*\]/.test(trimmed);       // Lines that are just closing brackets
                    
                    if (!isDebugOutput && trimmed.length > 0) {
                        // Check if this is a rate limit error
                        const isRateLimit = trimmed.includes('429') || 
                                           trimmed.includes('rateLimitExceeded') ||
                                           trimmed.includes('RESOURCE_EXHAUSTED') ||
                                           trimmed.includes('Resource exhausted') ||
                                           trimmed.includes('GaxiosError');
                        
                        // Forward to handler
                        this.handler?.({
                            type: 'error',
                            message: trimmed,
                            isRateLimit,
                            timestamp: Date.now()
                        });
                    }
                }
            });
            
            // Handle any remaining buffer on close
            this.process.stderr.on('end', () => {
                if (stderrBuffer.trim()) {
                    const trimmed = stderrBuffer.trim();
                    const isRateLimit = trimmed.includes('429') || 
                                       trimmed.includes('rateLimitExceeded') ||
                                       trimmed.includes('RESOURCE_EXHAUSTED');
                    
                    if (trimmed.length > 0) {
                        this.handler?.({
                            type: 'error',
                            message: trimmed,
                            isRateLimit,
                            timestamp: Date.now()
                        });
                    }
                }
            });
        }

        // Handle process exit
        this.process.on('exit', (code, signal) => {
            logger.debug(`[Gemini] Process exited: code=${code}, signal=${signal}`);
            if (this.stdoutReader) {
                this.stdoutReader.close();
                this.stdoutReader = null;
            }
            this.process = null;
        });

        // Handle process errors
        this.process.on('error', (error) => {
            logger.debug(`[Gemini] Process error:`, error);
            this.handler?.({
                type: 'error',
                message: error.message,
                timestamp: Date.now()
            });
        });

        const response: GeminiToolResponse = {
            content: [],
            isError: false
        };

        // Extract session/conversation IDs if present in initial response
        // (will be updated as messages come in)
        this.extractIdentifiers(response);

        return response;
    }

    /**
     * Continue an existing Gemini session by sending a new prompt
     */
    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<GeminiToolResponse> {
        logger.debug('[Gemini] Continuing session with prompt:', prompt);
        // Each continuation runs a fresh Gemini CLI invocation because the current CLI
        // lacks a clean API for streaming follow-up prompts non-interactively.
        const baseConfig: GeminiSessionConfig = this.lastSessionConfig ?? {
            cwd: process.cwd()
        };

        return this.startSession({
            ...baseConfig,
            prompt,
        }, options);
    }

    /**
     * Handle incoming messages from Gemini CLI
     */
    private handleMessage(message: any): void {
        logger.debug(`[Gemini] Received message:`, message);
        logger.infoDeveloper(`[Gemini] stream (${message?.type ?? 'unknown'})`, message);

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
            logger.debug('[Gemini] Session ID extracted from message:', this.sessionId);
        }

        const conversationId = message.conversationId || message.conversation_id || message.conversation?.id;
        if (conversationId && !this.conversationId) {
            this.conversationId = conversationId;
            logger.debug('[Gemini] Conversation ID extracted from message:', this.conversationId);
        }
    }

    /**
     * Extract session and conversation identifiers from response
     */
    private extractIdentifiers(response: any): void {
        const meta = response?.meta || {};
        if (meta.sessionId) {
            this.sessionId = meta.sessionId;
            logger.debug('[Gemini] Session ID extracted:', this.sessionId);
        } else if (response?.sessionId) {
            this.sessionId = response.sessionId;
            logger.debug('[Gemini] Session ID extracted:', this.sessionId);
        }

        if (meta.conversationId) {
            this.conversationId = meta.conversationId;
            logger.debug('[Gemini] Conversation ID extracted:', this.conversationId);
        } else if (response?.conversationId) {
            this.conversationId = response.conversationId;
            logger.debug('[Gemini] Conversation ID extracted:', this.conversationId);
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
        this.lastSessionConfig = null;
        logger.debug('[Gemini] Session cleared');
    }

    /**
     * Store session for resume (if supported)
     */
    storeSessionForResume(): string | null {
        // TODO: Implement session storage for resume if Gemini CLI supports it
        return this.sessionId;
    }

    /**
     * Disconnect from Gemini CLI
     */
    async disconnect(): Promise<void> {
        this.clearSession();
        this.connected = false;
        logger.debug('[Gemini] Disconnected from Gemini CLI');
    }
}

