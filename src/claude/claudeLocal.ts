import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { mkdirSync, existsSync } from "node:fs";
import { watch } from "node:fs";
import { logger } from "@/ui/logger";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { projectPath } from "@/projectPath";
import { systemPrompt } from "./utils/systemPrompt";
import { readSettings } from "@/persistence";
import { detectRouter, getCcrSpawnConfig } from "./utils/routerDetection";


// Get Claude CLI path from project root
export const claudeCliPath = resolve(join(projectPath(), 'scripts', 'claude_local_launcher.cjs'))

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
        await new Promise<void>(async (r, reject) => {
            // Check if router is enabled
            const settings = await readSettings();
            const useRouter = settings.router?.enabled ?? false;
            let routerDetection = null;

            if (useRouter) {
                logger.debug('[claudeLocal] Router enabled, detecting configuration...');
                routerDetection = await detectRouter(settings.router?.configPath);
                if (!routerDetection.isInstalled) {
                    logger.warn('[claudeLocal] Router enabled but not installed, falling back to direct Claude Code');
                } else if (routerDetection.error) {
                    logger.warn(`[claudeLocal] Router configuration issue: ${routerDetection.error}, falling back to direct Claude Code`);
                }
            }

            let executable: string;
            let args: string[] = [];
            let useRouterSpawn = false;

            if (useRouter && routerDetection && routerDetection.isInstalled && !routerDetection.error) {
                // Use router - set environment variables and use regular Claude Code
                executable = 'node';
                args.unshift(claudeCliPath);
                // Router environment variables will be set below
                useRouterSpawn = false; // Still use regular fd3 listening
                logger.debug(`[claudeLocal] Using router with regular Claude Code and router environment variables`);
            } else {
                // Use direct Claude Code
                executable = 'node';
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

                args.unshift(claudeCliPath);
            }

            // Prepare environment variables
            const env = {
                ...process.env,
                ...opts.claudeEnvVars
            }

            // Set router environment variables if using router
            if (useRouter && routerDetection && routerDetection.isInstalled && !routerDetection.error) {
                env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456'
                env.ANTHROPIC_AUTH_TOKEN = 'test' // Dummy token for router
                env.API_TIMEOUT_MS = '600000'
                env.NO_PROXY = '127.0.0.1'
                env.DISABLE_TELEMETRY = 'true'
                env.DISABLE_COST_WARNINGS = 'true'
                // Unset bedrock if it exists
                delete env.CLAUDE_CODE_USE_BEDROCK
                logger.debug('[claudeLocal] Set router environment variables')
            }

            const child = spawn(executable, args, {
                stdio: useRouterSpawn ? ['inherit', 'inherit', 'inherit'] : ['inherit', 'inherit', 'inherit', 'pipe'],
                signal: opts.abort,
                cwd: opts.path,
                env,
            });

            // Listen to the custom fd (fd 3) line by line (only for direct Claude Code, not router)
            if (!useRouterSpawn && child.stdio[3]) {
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