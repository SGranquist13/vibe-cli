import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { watch } from "node:fs";
import { logger } from "@/ui/logger";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { projectPath } from "@/projectPath";
import { systemPrompt } from "./utils/systemPrompt";
import { readSettings } from "@/persistence";
import { detectRouter, getCcrSpawnConfig } from "./utils/routerDetection";
import chalk from 'chalk';


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
            logger.debug(`[claudeLocal] File change detected: ${event} ${filename}`);
            const sessionId = filename.replace('.jsonl', '');
            if (detectedIdsFileSystem.has(sessionId)) {
                logger.debug(`[claudeLocal] Session ${sessionId} already detected, skipping`);
                return;
            }
            detectedIdsFileSystem.add(sessionId);
            logger.debug(`[claudeLocal] New session file detected: ${sessionId}, resolvedSessionId: ${resolvedSessionId}, hasUUID: ${detectedIdsRandomUUID.has(sessionId)}`);

            // Try to match
            if (resolvedSessionId) {
                logger.debug(`[claudeLocal] Already resolved session ${resolvedSessionId}, skipping ${sessionId}`);
                return;
            }

            // Try to match with random UUID
            if (detectedIdsRandomUUID.has(sessionId)) {
                logger.debug(`[claudeLocal] Matched session ${sessionId} with UUID, calling onSessionFound`);
                resolvedSessionId = sessionId;
                opts.onSessionFound(sessionId);
            } else {
                // Fallback: If we're using router mode or UUID hasn't arrived yet,
                // try to read the session ID from the file itself after a short delay
                logger.debug(`[claudeLocal] Session ${sessionId} detected but no matching UUID yet, will try fallback after delay`);
                setTimeout(() => {
                    if (!resolvedSessionId) {
                        try {
                            const sessionFile = join(projectDir, filename);
                            if (existsSync(sessionFile)) {
                                const content = readFileSync(sessionFile, 'utf-8');
                                const lines = content.split('\n').filter(l => l.trim());
                                if (lines.length > 0) {
                                    const firstMessage = JSON.parse(lines[0]);
                                    // Check if this is a valid session file with sessionId field
                                    if (firstMessage.sessionId || firstMessage.type) {
                                        logger.debug(`[claudeLocal] Fallback: Using session ${sessionId} from file (router mode or UUID delayed)`);
                                        resolvedSessionId = sessionId;
                                        opts.onSessionFound(sessionId);
                                    }
                                }
                            }
                        } catch (error) {
                            logger.debug(`[claudeLocal] Fallback failed to read session file: ${error}`);
                        }
                    }
                }, 2000); // Wait 2 seconds for UUID, then fallback
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
            let useRouter = settings.router?.enabled ?? false;
            let routerDetection = null;

            if (useRouter) {
                logger.debug('[claudeLocal] Router enabled, detecting configuration...');
                routerDetection = await detectRouter(settings.router?.configPath);
                if (!routerDetection.isInstalled) {
                    console.log(chalk.yellow('⚠️  Claude Code Router is enabled but not installed.'));
                    console.log(chalk.yellow('   Falling back to direct Claude Code.'));
                    console.log(chalk.gray('   To install: npm install -g @musistudio/claude-code-router'));
                    console.log(chalk.gray('   To disable: vibe router disable'));
                    logger.warn('[claudeLocal] Router enabled but not installed, falling back to direct Claude Code');
                    useRouter = false; // Disable router usage
                } else if (routerDetection.error) {
                    console.log(chalk.yellow('⚠️  Claude Code Router is enabled but has configuration issues.'));
                    console.log(chalk.yellow(`   ${routerDetection.error}`));
                    console.log(chalk.yellow('   Falling back to direct Claude Code.'));
                    console.log(chalk.gray('   To fix: Run "ccr model" to configure, or "vibe router disable" to disable.'));
                    logger.warn(`[claudeLocal] Router configuration issue: ${routerDetection.error}, falling back to direct Claude Code`);
                    useRouter = false; // Disable router usage
                } else {
                    // Router is installed and configured, ensure service is running
                    try {
                        const { ensureRouterServiceRunning } = await import('./utils/routerService');
                        // Give service a moment to start if it was just launched
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        const serviceResult = await ensureRouterServiceRunning();
                        
                        if (!serviceResult.isRunning) {
                            console.log(chalk.yellow('⚠️  Claude Code Router is configured but service is not running.'));
                            console.log(chalk.yellow('   Falling back to direct Claude Code.'));
                            if (serviceResult.error) {
                                console.log(chalk.gray(`   ${serviceResult.error}`));
                            }
                            console.log(chalk.gray('   To start service: Run "ccr start" manually.'));
                            logger.warn('[claudeLocal] Router configured but service not running, falling back to direct Claude Code');
                            useRouter = false; // Disable router usage
                        } else {
                            if (serviceResult.wasStarted) {
                                logger.debug('[claudeLocal] Router service was started successfully');
                            } else {
                                logger.debug('[claudeLocal] Router service was already running');
                            }
                        }
                    } catch (error) {
                        logger.debug(`[claudeLocal] Failed to ensure router service is running: ${error}`);
                        // If we can't ensure service is running, don't use router to be safe
                        useRouter = false;
                    }
                }
            }

            // Final check: if router was enabled but we disabled it due to service not running,
            // check one more time right before spawning (service might have started)
            if (!useRouter && settings.router?.enabled && routerDetection && routerDetection.isInstalled && !routerDetection.error) {
                try {
                    const { checkRouterServiceStatus } = await import('./utils/routerService');
                    // Wait a bit more for service to fully start
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const finalCheck = await checkRouterServiceStatus();
                    if (finalCheck.isRunning) {
                        logger.debug('[claudeLocal] Router service is now running, enabling router usage');
                        useRouter = true;
                    }
                } catch (error) {
                    logger.debug(`[claudeLocal] Final router service check failed: ${error}`);
                }
            }

            let executable: string;
            let args: string[] = [];
            let useRouterSpawn = false;

            // Only use router if it's enabled, detected, and service is running
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
            if (!useRouter && child.stdio[3]) {
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
                                logger.debug(`[claudeLocal] Received UUID: ${message.value}`);
                                detectedIdsRandomUUID.add(message.value);

                                if (!resolvedSessionId && detectedIdsFileSystem.has(message.value)) {
                                    logger.debug(`[claudeLocal] UUID ${message.value} matches file system, calling onSessionFound`);
                                    resolvedSessionId = message.value;
                                    opts.onSessionFound(message.value);
                                } else if (!resolvedSessionId) {
                                    logger.debug(`[claudeLocal] UUID ${message.value} received but file not detected yet, waiting...`);
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
                    logger.warn('[claudeLocal] Error reading from fd 3:', err);
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