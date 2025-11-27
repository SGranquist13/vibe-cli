/**
 * Gemini Permission Handler
 * 
 * Handles tool permission requests for Gemini CLI.
 * This is a separate implementation from Claude and Codex to maintain separation of concerns.
 */

import { logger } from '@/ui/logger';
import { ApiSessionClient } from '@/api/apiSession';
import { randomUUID } from 'node:crypto';

export interface PermissionResult {
    decision: 'approved' | 'denied';
    reason?: string;
}

interface PendingRequest {
    resolve: (result: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

/**
 * Permission handler for Gemini CLI tool calls
 */
export class GeminiPermissionHandler {
    private pendingRequests = new Map<string, PendingRequest>();
    private session: ApiSessionClient;

    constructor(session: ApiSessionClient) {
        this.session = session;
        this.setupRpcHandler();
    }

    /**
     * Setup RPC handler for permission responses from mobile app
     */
    private setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler('permission', async (params: any) => {
            const { requestId, approved, reason } = params;

            const pending = this.pendingRequests.get(requestId);
            if (pending) {
                this.pendingRequests.delete(requestId);
                pending.resolve({
                    decision: approved ? 'approved' : 'denied',
                    reason
                });
            } else {
                logger.debug(`[Gemini] Permission response for unknown request: ${requestId}`);
            }

            return { success: true };
        });
    }

    /**
     * Handle a tool permission request
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

            // Update agent state with pending request
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests || {},
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            logger.debug(`[Gemini] Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }

    /**
     * Reset permission handler state
     */
    reset(): void {
        // Reject all pending requests
        for (const [requestId, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Permission handler reset'));
        }
        this.pendingRequests.clear();
        logger.debug('[Gemini] Permission handler reset');
    }
}




