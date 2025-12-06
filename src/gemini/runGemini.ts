/**
 * Gemini CLI Integration - Main Entry Point
 * 
 * This is the main entry point for Gemini CLI sessions.
 * It follows the same pattern as Claude and Codex but maintains complete separation.
 */

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { AgentState, Metadata } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { GeminiClient } from './geminiClient';
import { GeminiPermissionHandler } from './utils/permissionHandler';
import { startVibeServer } from '@/claude/utils/startVibeServer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { trimIdent } from '@/utils/trimIdent';
import type { GeminiSessionConfig } from './types';
import { handleGeminiMessage } from './utils/messageHandler';
import { isEchoOfUserMessage } from './utils/echoDetector';

/**
 * Main entry point for Gemini CLI sessions
 */
export async function runGemini(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    type PermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
    }

    // Create session
    const sessionTag = randomUUID();
    const api = await ApiClient.create(opts.credentials);

    logger.debug(`[Gemini] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    // Machine setup
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

    // Create session
    let state: AgentState = {
        controlledByUser: false,
    };
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
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);

    // Report to daemon if it exists
    try {
        logger.debug(`[START] Reporting session ${response.id} to daemon`);
        const result = await notifyDaemonSessionStarted(response.id, metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${response.id} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }

    // Create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides
    let currentPermissionMode: PermissionMode | undefined = undefined;
    let currentModel: string | undefined = undefined;

    // Handle user messages
    session.onUserMessage((message) => {
        // Store the user's message early to help detect echoes
        if (!initialUserMessage && message.content.text) {
            initialUserMessage = message.content.text;
            hasReceivedFirstRealResponse = false;
            logger.debug(`[Gemini] Stored initial user message: "${initialUserMessage.substring(0, 50)}..."`);
        }
        
        // Resolve permission mode
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[Gemini] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Gemini] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[Gemini] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Gemini] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Gemini] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
        };
        messageQueue.push(message.content.text, enhancedMode);
    });

    // Thinking state tracking
    let thinking = false;
    session.keepAlive(thinking, 'remote');
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    // Ready event sender
    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                "It's ready!",
                'Gemini is waiting for your command',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[Gemini] Failed to send ready push', pushError);
        }
    };

    // Abort handling
    let abortController = new AbortController();
    let shouldExit = false;

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

    const handleKillSession = async () => {
        logger.debug('[Gemini] Kill session requested - terminating process');
        await handleAbort();

        try {
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));

                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            stopCaffeinate();
            vibeServer.stop();

            logger.debug('[Gemini] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Gemini] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register handlers
    session.rpcHandlerManager.registerHandler('abort', handleAbort);
    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    // Start Vibe MCP server
    const vibeServer = await startVibeServer(session);
    const bridgeCommand = resolve(projectPath(), 'bin', 'vibe-mcp.mjs');
    const mcpServers = {
        vibe: {
            command: bridgeCommand,
            args: ['--url', vibeServer.url]
        }
    } as const;

    // Initialize Gemini client
    const client = new GeminiClient();
    const permissionHandler = new GeminiPermissionHandler(session);

    // Track initial user message to filter out echo/duplicate first response
    let initialUserMessage: string | null = null;
    let hasReceivedFirstRealResponse: boolean = false;

    // Track pending rate limit errors that are being retried
    type PendingRateLimitError = { message: string; timeout: NodeJS.Timeout };
    let pendingRateLimitError: PendingRateLimitError | null = null;

    // Setup event handler
    client.setHandler((msg) => {
        logger.debug(`[Gemini] Message: ${JSON.stringify(msg)}`);

        // If we get a successful message/response, clear any pending rate limit error
        if (msg.type === 'message' || msg.type === 'assistant' || msg.type === 'assistant_message' || msg.type === 'result') {
            if (pendingRateLimitError !== null) {
                logger.debug('[Gemini] Successful response received, suppressing pending rate limit error');
                clearTimeout(pendingRateLimitError.timeout);
                pendingRateLimitError = null;
            }
        }

        // Process message using handler
        handleGeminiMessage(msg, session, {
            onThinkingChange: (newThinking) => {
                thinking = newThinking;
                session.keepAlive(thinking, 'remote');
            },
            onComplete: () => {
                hasReceivedFirstRealResponse = true;
                // Clear pending rate limit error on completion
                if (pendingRateLimitError !== null) {
                    logger.debug('[Gemini] Request completed successfully, suppressing pending rate limit error');
                    clearTimeout(pendingRateLimitError.timeout);
                    pendingRateLimitError = null;
                }
                sendReady();
            },
            // Echo detection callback - check before sending message
            shouldSkipMessage: (messageText: string) => {
                if (!hasReceivedFirstRealResponse && initialUserMessage && isEchoOfUserMessage(messageText, initialUserMessage)) {
                    logger.debug(`[Gemini] Skipping duplicate first response (echo of user message). User: "${initialUserMessage.substring(0, 50)}...", Echo: "${messageText.substring(0, 50)}..."`);
                    hasReceivedFirstRealResponse = true;
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                    return true;
                }
                return false;
            },
            // Rate limit error handler - track pending errors
            onRateLimitError: (errorMessage: string) => {
                // Check if error mentions retrying
                if (errorMessage.includes('Retrying with backoff') || errorMessage.includes('retrying')) {
                    logger.debug('[Gemini] Rate limit error with retry detected, will suppress if retry succeeds');
                    
                    // Clear any existing pending error
                    if (pendingRateLimitError !== null) {
                        clearTimeout(pendingRateLimitError.timeout);
                    }
                    
                    // Store the error and set a timeout to show it if retry fails
                    pendingRateLimitError = {
                        message: errorMessage,
                        timeout: setTimeout(() => {
                            // Only show if still pending (retry didn't succeed)
                            if (pendingRateLimitError !== null) {
                                logger.debug('[Gemini] Rate limit retry timeout expired, showing error');
                                handleGeminiMessage({
                                    type: 'error',
                                    message: errorMessage,
                                    isRateLimit: true
                                }, session, {
                                    onThinkingChange: (newThinking) => {
                                        thinking = newThinking;
                                        session.keepAlive(thinking, 'remote');
                                    }
                                });
                                pendingRateLimitError = null;
                            }
                        }, 60000) // 60 second timeout - if no success by then, show the error
                    };
                    
                    // Don't show the error immediately
                    return true; // Suppress the error
                }
                return false; // Show the error normally
            }
        });
        
        // Mark as received if it's a complete message
        if (msg.type === 'message' || msg.type === 'assistant' || msg.type === 'assistant_message') {
            if (!msg.delta && (msg.message || msg.text || msg.content)) {
                hasReceivedFirstRealResponse = true;
            }
        }
    });

    let first = true;
    let wasCreated = false;
    let currentModeHash: string | null = null;

    try {
        await client.connect();

        while (!shouldExit) {
            // Get next message from queue
            const batch = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
            if (!batch) {
                if (abortController.signal.aborted && !shouldExit) {
                    logger.debug('[Gemini] Wait aborted while idle; ignoring and continuing');
                    continue;
                }
                break;
            }

            const message = batch;

            // Check for mode change
            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Gemini] Mode changed – restarting Gemini session');
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                permissionHandler.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                // Reset first response tracking for new session
                initialUserMessage = null;
                hasReceivedFirstRealResponse = false;
                continue;
            }

            currentModeHash = message.hash;

            try {
                if (!wasCreated) {
                    const interactiveEnv = String(process.env.VIBE_GEMINI_INTERACTIVE || '').toLowerCase();
                    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY && (interactiveEnv === '1' || interactiveEnv === 'true' || interactiveEnv === 'yes'));
                    
                    const promptText = first ? message.message + '\n\n' + trimIdent(`Based on this message, call functions.vibe__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`) : message.message;
                    
                    // Store initial user message to filter out echo/duplicate first response
                    if (!isInteractive && message.message) {
                        initialUserMessage = message.message;
                        hasReceivedFirstRealResponse = false;
                    }
                    
                    const startConfig: GeminiSessionConfig = {
                        prompt: isInteractive ? undefined : promptText,
                        cwd: process.cwd(),
                        mcpServers: mcpServers
                    };
                    if (message.mode.model) {
                        startConfig.model = message.mode.model;
                    }

                    await client.startSession(startConfig, { signal: abortController.signal });
                    wasCreated = true;
                    first = false;
                    
                    // In interactive mode, wait for process to exit (user will interact directly)
                    if (isInteractive && client.hasActiveSession()) {
                        // Process will run until user exits (Ctrl+C or similar)
                        // We'll continue the loop when process exits
                        await new Promise<void>((resolve) => {
                            const checkInterval = setInterval(() => {
                                if (!client.hasActiveSession()) {
                                    clearInterval(checkInterval);
                                    resolve();
                                }
                            }, 100);
                            
                            // Also resolve on abort
                            abortController.signal.addEventListener('abort', () => {
                                clearInterval(checkInterval);
                                resolve();
                            });
                        });
                    }
                } else {
                    await client.continueSession(message.message, { signal: abortController.signal });
                }
            } catch (error) {
                logger.warn('Error in Gemini session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';

                if (isAbortError) {
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    wasCreated = false;
                    currentModeHash = null;
                } else {
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                }
            } finally {
                permissionHandler.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
        }
    } finally {
        // Cleanup
        logger.debug('[Gemini] Final cleanup start');
        
        // Clear any pending rate limit error timeout
        if (pendingRateLimitError !== null) {
            clearTimeout((pendingRateLimitError as PendingRateLimitError).timeout);
            pendingRateLimitError = null;
        }
        
        try {
            session.sendSessionDeath();
            await session.flush();
            await session.close();
        } catch (e) {
            logger.debug('[Gemini] Error while closing session', e);
        }

        await client.disconnect();
        vibeServer.stop();
        clearInterval(keepAliveInterval);
        stopCaffeinate();

        logger.debug('[Gemini] Final cleanup completed');
    }
}

