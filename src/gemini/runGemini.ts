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

/**
 * Check if a string looks like Gemini CLI debug/info output that should be filtered
 */
function isGeminiDebugOutput(text: string): boolean {
    if (!text || text.length === 0) return true;
    
    return (
        // Debug prefixes
        /^\[?(DEBUG|INFO|TRACE|WARN)\]?\s/i.test(text) ||
        // Internal component logs
        text.includes('[MemoryDiscovery]') ||
        text.includes('[BfsFileSearch]') ||
        text.includes('[AgentRegistry]') ||
        // Progress indicators
        text.includes('Scanning [') ||
        text.includes('batch of') ||
        // Experiment/config loading
        text.includes('Experiments loaded') ||
        text.includes('experimentIds') ||
        text.includes('flagId') ||
        text.includes('floatValue') ||
        text.includes('stringValue') ||
        // Session info
        text.includes('Session ID:') ||
        // Log flushing
        text.includes('Flushing log events') ||
        text.includes('Clearcut') ||
        // Credentials
        text.includes('cached credentials') ||
        text.includes('Loaded cached') ||
        // Various startup messages
        text.startsWith('Loading') ||
        text.startsWith('Loaded') ||
        text.startsWith('Found readable') ||
        text.startsWith('Searching for') ||
        text.startsWith('Determined project') ||
        text.startsWith('Initialized with') ||
        // JSON fragments (partial objects/arrays)
        /^\s*[\[\{]/.test(text) ||  // Lines starting with [ or {
        /^\s*\d+,?\s*$/.test(text) || // Lines that are just numbers
        /^\s*[\]\}],?\s*$/.test(text) // Lines that are just closing brackets
    );
}

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

    // Track streaming message content for accumulation
    let currentMessageContent: string = '';
    let isStreamingMessage: boolean = false;

    // Helper function to flush accumulated message content
    const flushAccumulatedMessage = () => {
        if (isStreamingMessage && currentMessageContent.length > 0) {
            session.sendGeminiMessage({
                type: 'message',
                message: currentMessageContent,
                id: randomUUID()
            });
            currentMessageContent = '';
            isStreamingMessage = false;
        }
    };

    // Setup event handler
    client.setHandler((msg) => {
        logger.debug(`[Gemini] Message: ${JSON.stringify(msg)}`);

        // Process Gemini CLI stream-json messages
        // Gemini CLI outputs JSON lines with different message types
        const msgType = msg.type || msg.event || 'unknown';

        switch (msgType) {
            case 'message':
            case 'assistant':
            case 'assistant_message':
                // Assistant text message - handle streaming deltas
                const messageText = msg.message || msg.text || msg.content || '';
                const isDelta = msg.delta === true;
                
                if (isDelta) {
                    // Accumulate streaming content
                    isStreamingMessage = true;
                    currentMessageContent += messageText;
                    // Don't send yet, wait for complete message
                } else {
                    // Complete message - send accumulated or current content
                    const finalContent = isStreamingMessage ? currentMessageContent + messageText : messageText;
                    if (finalContent.length > 0) {
                        session.sendGeminiMessage({
                            type: 'message',
                            message: finalContent,
                            id: randomUUID()
                        });
                    }
                    // Reset streaming state
                    currentMessageContent = '';
                    isStreamingMessage = false;
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                }
                break;

            case 'tool_use':
                // Flush any accumulated message content before tool call
                flushAccumulatedMessage();
                // Gemini CLI uses tool_use (not tool_call)
                // Map fields: tool_name → name, tool_id → callId, parameters → input
                session.sendGeminiMessage({
                    type: 'tool-call',
                    name: msg.tool_name || msg.name || 'unknown',
                    callId: msg.tool_id || msg.toolId || msg.call_id || randomUUID(),
                    input: msg.parameters || msg.input || {},
                    id: randomUUID()
                });
                break;

            case 'tool_call':
            case 'function_call':
                // Flush any accumulated message content before tool call
                flushAccumulatedMessage();
                // Fallback for other possible event types
                session.sendGeminiMessage({
                    type: 'tool-call',
                    name: msg.name || msg.function_name || msg.tool_name || 'unknown',
                    callId: msg.call_id || msg.tool_id || msg.toolId || msg.id || randomUUID(),
                    input: msg.input || msg.arguments || msg.parameters || {},
                    id: randomUUID()
                });
                break;

            case 'tool_result':
                // Tool result - map fields correctly
                session.sendGeminiMessage({
                    type: 'tool-call-result',
                    callId: msg.tool_id || msg.toolId || msg.call_id || msg.id || randomUUID(),
                    output: msg.output || msg.result || {},
                    is_error: msg.status === 'error' || msg.status === 'failed' || false,
                    id: randomUUID()
                });
                break;

            case 'function_result':
                // Fallback for function_result
                session.sendGeminiMessage({
                    type: 'tool-call-result',
                    callId: msg.call_id || msg.tool_id || msg.toolId || msg.id || randomUUID(),
                    output: msg.output || msg.result || {},
                    is_error: msg.status === 'error' || msg.status === 'failed' || false,
                    id: randomUUID()
                });
                break;

            case 'thinking':
            case 'reasoning':
                // Thinking/reasoning indicator
                if (!thinking) {
                    thinking = true;
                    session.keepAlive(thinking, 'remote');
                }
                // Optionally send thinking messages to mobile
                if (msg.text || msg.content) {
                    session.sendGeminiMessage({
                        type: 'thinking',
                        message: msg.text || msg.content || '',
                        id: randomUUID()
                    });
                }
                break;

            case 'error':
                // Error message - only send if it looks like a real error
                const errorText = msg.message || msg.error || '';
                // Filter out debug-like "errors" which are actually info/progress messages
                const isDebugError = isGeminiDebugOutput(errorText);
                
                if (errorText.length > 0 && !isDebugError) {
                    session.sendGeminiMessage({
                        type: 'error',
                        message: errorText,
                        id: randomUUID()
                    });
                }
                break;

            case 'system':
            case 'system_message':
                // System message
                session.sendGeminiMessage({
                    type: 'system',
                    message: msg.message || msg.text || '',
                    id: randomUUID()
                });
                break;

            case 'done':
            case 'complete':
            case 'finished':
                // Flush any accumulated message content
                flushAccumulatedMessage();
                // Task completed
                thinking = false;
                session.keepAlive(thinking, 'remote');
                sendReady();
                break;

            case 'result':
                // Flush any accumulated message content before result
                flushAccumulatedMessage();
                // Result event contains stats/metadata
                thinking = false;
                session.keepAlive(thinking, 'remote');
                
                // Extract and send usage statistics if available
                if (msg.stats) {
                    const stats = msg.stats;
                    try {
                        // Transform Gemini stats to Claude-like usage format
                        const usage = {
                            input_tokens: stats.input_tokens || 0,
                            output_tokens: stats.output_tokens || 0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0
                        };
                        
                        // Send usage data via session client
                        session.sendUsageData(usage);
                        logger.debug(`[Gemini] Sent usage stats: ${JSON.stringify(usage)}`);
                    } catch (error) {
                        logger.debug('[Gemini] Failed to send usage data:', error);
                    }
                }
                
                // Send ready event after result
                sendReady();
                break;

            case 'progress':
            case 'status':
            case 'log':
            case 'debug':
            case 'info':
                // Progress/status updates - just log, don't send to mobile
                logger.debug(`[Gemini] Progress: ${msg.message || msg.text || JSON.stringify(msg)}`);
                break;

            default:
                // Unknown message type - only send if it has meaningful text content
                logger.debug(`[Gemini] Unknown message type: ${msgType}`);
                const unknownText = msg.message || msg.text || msg.content;
                // Only send if there's actual text content and it's not debug output
                if (typeof unknownText === 'string' && unknownText.length > 0) {
                    if (!isGeminiDebugOutput(unknownText)) {
                        session.sendGeminiMessage({
                            type: 'message',
                            message: unknownText,
                            id: randomUUID()
                        });
                    }
                }
                // Don't send raw JSON objects as messages
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
                continue;
            }

            currentModeHash = message.hash;

            try {
                if (!wasCreated) {
                    const interactiveEnv = String(process.env.VIBE_GEMINI_INTERACTIVE || '').toLowerCase();
                    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY && (interactiveEnv === '1' || interactiveEnv === 'true' || interactiveEnv === 'yes'));
                    
                    const promptText = first ? message.message + '\n\n' + trimIdent(`Based on this message, call functions.vibe__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`) : message.message;
                    
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

