/**
 * Cursor CLI Integration - Main Entry Point
 * 
 * This is the main entry point for Cursor CLI (cursor-agent) sessions.
 * It follows the same pattern as Claude, Codex, and Gemini but maintains complete separation.
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
import { CursorClient } from './cursorClient';
import { CursorPermissionHandler } from './utils/permissionHandler';
import { startVibeServer } from '@/claude/utils/startVibeServer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { trimIdent } from '@/utils/trimIdent';
import type { CursorSessionConfig } from './types';

/**
 * Main entry point for Cursor CLI sessions
 */
export async function runCursor(opts: {
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

    logger.debug(`[Cursor] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

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
        flavor: 'cursor' // Cursor flavor
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
                logger.debug(`[Cursor] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Cursor] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[Cursor] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Cursor] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Cursor] User message received with no model override, using current: ${currentModel || 'default'}`);
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
                'Cursor is waiting for your command',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[Cursor] Failed to send ready push', pushError);
        }
    };

    // Abort handling
    let abortController = new AbortController();
    let shouldExit = false;

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

    const handleKillSession = async () => {
        logger.debug('[Cursor] Kill session requested - terminating process');
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

            logger.debug('[Cursor] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Cursor] Error during session termination:', error);
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

    // Initialize Cursor client
    const client = new CursorClient();
    const permissionHandler = new CursorPermissionHandler(session);

    // Setup event handler
    client.setHandler((msg) => {
        logger.debug(`[Cursor] Message: ${JSON.stringify(msg)}`);

        // Process cursor-agent messages
        const msgType = msg.type || msg.event || 'unknown';

        switch (msgType) {
            case 'message':
            case 'assistant':
            case 'assistant_message':
                // Assistant text message
                const messageText = msg.message || msg.text || msg.content || '';
                session.sendCursorMessage({
                    type: 'message',
                    message: messageText,
                    id: randomUUID()
                });
                if (msgType === 'message' || msgType === 'assistant') {
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                }
                break;

            case 'tool_call':
            case 'function_call':
                // Tool/function call
                session.sendCursorMessage({
                    type: 'tool-call',
                    name: msg.name || msg.function_name || 'unknown',
                    callId: msg.call_id || msg.id || randomUUID(),
                    input: msg.input || msg.arguments || {},
                    id: randomUUID()
                });
                break;

            case 'tool_result':
            case 'function_result':
                // Tool/function result
                session.sendCursorMessage({
                    type: 'tool-call-result',
                    callId: msg.call_id || msg.id || randomUUID(),
                    output: msg.output || msg.result || {},
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
                if (msg.text || msg.content || msg.message) {
                    session.sendCursorMessage({
                        type: 'thinking',
                        message: msg.text || msg.content || msg.message || '',
                        id: randomUUID()
                    });
                }
                break;

            case 'error':
                // Error message
                session.sendCursorMessage({
                    type: 'error',
                    message: msg.message || msg.error || 'Unknown error',
                    id: randomUUID()
                });
                break;

            case 'system':
            case 'system_message':
                // System message
                session.sendCursorMessage({
                    type: 'system',
                    message: msg.message || msg.text || '',
                    id: randomUUID()
                });
                break;

            case 'done':
            case 'complete':
            case 'finished':
                // Task completed
                thinking = false;
                session.keepAlive(thinking, 'remote');
                sendReady();
                break;

            default:
                // Unknown message type - send as generic message
                logger.debug(`[Cursor] Unknown message type: ${msgType}`);
                if (msg.message || msg.text || msg.content) {
                    session.sendCursorMessage({
                        type: 'message',
                        message: msg.message || msg.text || msg.content || JSON.stringify(msg),
                        id: randomUUID()
                    });
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
                    logger.debug('[Cursor] Wait aborted while idle; ignoring and continuing');
                    continue;
                }
                break;
            }

            const message = batch;

            // Check for mode change
            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Cursor] Mode changed – restarting Cursor session');
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
                    // Determine if we're in a TTY
                    const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

                    const promptText = first ? message.message + '\n\n' + trimIdent(`Based on this message, call functions.vibe__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`) : message.message;

                    const startConfig: CursorSessionConfig = {
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

                    // In interactive mode, wait for process to exit
                    if (isInteractive && client.hasActiveSession()) {
                        await new Promise<void>((resolve) => {
                            const checkInterval = setInterval(() => {
                                if (!client.hasActiveSession()) {
                                    clearInterval(checkInterval);
                                    resolve();
                                }
                            }, 100);

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
                logger.warn('Error in Cursor session:', error);
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
        logger.debug('[Cursor] Final cleanup start');
        try {
            session.sendSessionDeath();
            await session.flush();
            await session.close();
        } catch (e) {
            logger.debug('[Cursor] Error while closing session', e);
        }

        await client.disconnect();
        vibeServer.stop();
        clearInterval(keepAliveInterval);
        stopCaffeinate();

        logger.debug('[Cursor] Final cleanup completed');
    }
}




