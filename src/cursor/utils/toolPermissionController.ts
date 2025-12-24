import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { CursorPermissionHandler, PermissionResult } from './permissionHandler';

type PermissionHandlerLike = Pick<CursorPermissionHandler, 'handleToolCall'>;
type SessionMessenger = Pick<ApiSessionClient, 'sendCursorMessage'>;

export interface CursorToolCallPayload {
    callId: string;
    toolName: string;
    input: unknown;
}

interface CursorToolPermissionControllerDeps {
    permissionHandler: PermissionHandlerLike;
    session: SessionMessenger;
    /**
     * Invoked when a permission result requires aborting the current Cursor turn.
     */
    onPermissionDenied: () => Promise<void>;
    /**
     * Override for deterministic testing.
     */
    createMessageId?: () => string;
}

export class CursorToolPermissionController {
    private readonly createMessageId: () => string;
    private readonly pendingRequests = new Set<string>();

    constructor(
        private readonly deps: CursorToolPermissionControllerDeps
    ) {
        this.createMessageId = deps.createMessageId ?? randomUUID;
    }

    handleToolCall(payload: CursorToolCallPayload): void {
        if (this.pendingRequests.has(payload.callId)) {
            return;
        }

        this.pendingRequests.add(payload.callId);
        void this.process(payload);
    }

    reset(): void {
        this.pendingRequests.clear();
    }

    private async process(payload: CursorToolCallPayload): Promise<void> {
        try {
            const result = await this.deps.permissionHandler.handleToolCall(
                payload.callId,
                payload.toolName,
                payload.input
            );

            this.sendDecisionMessage(payload.toolName, result);

            if (result.decision === 'denied' || result.decision === 'abort') {
                await this.deps.onPermissionDenied();
            }
        } catch (error) {
            logger.warn('[Cursor] Permission request failed', error);
            this.deps.session.sendCursorMessage({
                type: 'error',
                message: 'Permission request failed. Please retry the command.',
                id: this.createMessageId()
            });
        } finally {
            this.pendingRequests.delete(payload.callId);
        }
    }

    private sendDecisionMessage(toolName: string, result: PermissionResult): void {
        const message = this.buildMessage(toolName, result);
        if (!message) {
            return;
        }

        const type = result.decision === 'approved' || result.decision === 'approved_for_session'
            ? 'system'
            : 'error';

        this.deps.session.sendCursorMessage({
            type,
            message,
            id: this.createMessageId()
        });
    }

    private buildMessage(toolName: string, result: PermissionResult): string | null {
        switch (result.decision) {
            case 'approved':
                return `Permission granted for ${toolName}`;
            case 'approved_for_session':
                return `Permission granted for ${toolName} (entire session)`;
            case 'denied':
                return `${toolName} blocked by user`;
            case 'abort':
                return `${toolName} aborted`;
            default:
                return null;
        }
    }
}

