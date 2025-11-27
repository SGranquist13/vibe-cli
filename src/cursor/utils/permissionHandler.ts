/**
 * Cursor Permission Handler
 * 
 * Handles tool permission requests for Cursor CLI (cursor-agent).
 * This is a separate implementation from Claude, Codex, and Gemini to maintain separation of concerns.
 */

import { logger } from '@/ui/logger';
import { ApiSessionClient } from '@/api/apiSession';
import { AgentState } from '@/api/types';

export interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
    allowTools?: string[];
}

interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
}

interface PendingRequest {
    resolve: (result: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

/**
 * Permission handler for Cursor CLI tool calls
 */
export class CursorPermissionHandler {
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
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug('[Cursor] Permission request not found or already resolved');
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);

                // Resolve the permission request
                const result: PermissionResult = response.approved
                    ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved' }
                    : { decision: response.decision === 'denied' ? 'denied' : 'abort' };

                pending.resolve(result);

                // Move request to completed in agent state
                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    return {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [response.id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: response.approved ? 'approved' : 'denied',
                                decision: result.decision
                            }
                        }
                    } satisfies AgentState;
                });

                logger.debug(`[Cursor] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
            }
        );
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

            logger.debug(`[Cursor] Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }

    /**
     * Reset permission handler state
     */
    reset(): void {
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Clear requests in agent state
        this.session.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move all pending to completed as canceled
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Session reset'
                };
            }

            return {
                ...currentState,
                requests: {},
                completedRequests
            };
        });

        logger.debug('[Cursor] Permission handler reset');
    }
}




