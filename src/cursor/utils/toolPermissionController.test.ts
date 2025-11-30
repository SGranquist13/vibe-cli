import { describe, expect, it, vi } from 'vitest';

import { CursorToolPermissionController } from './toolPermissionController';
import type { PermissionResult } from './permissionHandler';

function flushAllPromises(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CursorToolPermissionController', () => {
    it('requests permission and sends approval message', async () => {
        const permissionResult: PermissionResult = { decision: 'approved' };
        const handleToolCall = vi.fn().mockResolvedValue(permissionResult);
        const sendCursorMessage = vi.fn();
        const onPermissionDenied = vi.fn().mockResolvedValue(undefined);

        const controller = new CursorToolPermissionController({
            permissionHandler: { handleToolCall },
            session: { sendCursorMessage },
            onPermissionDenied,
            createMessageId: () => 'msg-1'
        });

        controller.handleToolCall({
            callId: 'call-1',
            toolName: 'Bash',
            input: { command: 'ls' }
        });

        await flushAllPromises();

        expect(handleToolCall).toHaveBeenCalledWith('call-1', 'Bash', { command: 'ls' });
        expect(sendCursorMessage).toHaveBeenCalledWith({
            type: 'system',
            message: 'Permission granted for Bash',
            id: 'msg-1'
        });
        expect(onPermissionDenied).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent permission requests for the same callId', async () => {
        let resolveApproval: (value: PermissionResult) => void = () => {};
        const handleToolCall = vi.fn(() => new Promise<PermissionResult>((resolve) => {
            resolveApproval = resolve;
        }));
        const sendCursorMessage = vi.fn();
        const onPermissionDenied = vi.fn().mockResolvedValue(undefined);

        const controller = new CursorToolPermissionController({
            permissionHandler: { handleToolCall },
            session: { sendCursorMessage },
            onPermissionDenied,
            createMessageId: () => 'msg-2'
        });

        controller.handleToolCall({
            callId: 'call-dupe',
            toolName: 'Bash',
            input: { command: 'pwd' }
        });
        controller.handleToolCall({
            callId: 'call-dupe',
            toolName: 'Bash',
            input: { command: 'pwd' }
        });

        expect(handleToolCall).toHaveBeenCalledTimes(1);

        resolveApproval({ decision: 'approved' });
        await flushAllPromises();

        expect(sendCursorMessage).toHaveBeenCalledWith({
            type: 'system',
            message: 'Permission granted for Bash',
            id: 'msg-2'
        });
    });

    it('invokes onPermissionDenied when result is denied', async () => {
        const handleToolCall = vi.fn().mockResolvedValue({ decision: 'denied' } satisfies PermissionResult);
        const sendCursorMessage = vi.fn();
        const onPermissionDenied = vi.fn().mockResolvedValue(undefined);

        const controller = new CursorToolPermissionController({
            permissionHandler: { handleToolCall },
            session: { sendCursorMessage },
            onPermissionDenied,
            createMessageId: () => 'msg-3'
        });

        controller.handleToolCall({
            callId: 'call-denied',
            toolName: 'GitApply',
            input: {}
        });

        await flushAllPromises();

        expect(sendCursorMessage).toHaveBeenCalledWith({
            type: 'error',
            message: 'GitApply blocked by user',
            id: 'msg-3'
        });
        expect(onPermissionDenied).toHaveBeenCalledTimes(1);
    });

    it('sends error message when permission handler throws', async () => {
        const handleToolCall = vi.fn().mockRejectedValue(new Error('boom'));
        const sendCursorMessage = vi.fn();
        const onPermissionDenied = vi.fn().mockResolvedValue(undefined);

        const controller = new CursorToolPermissionController({
            permissionHandler: { handleToolCall },
            session: { sendCursorMessage },
            onPermissionDenied,
            createMessageId: () => 'msg-4'
        });

        controller.handleToolCall({
            callId: 'call-error',
            toolName: 'Shell',
            input: {}
        });

        await flushAllPromises();

        expect(sendCursorMessage).toHaveBeenCalledWith({
            type: 'error',
            message: 'Permission request failed. Please retry the command.',
            id: 'msg-4'
        });
        expect(onPermissionDenied).not.toHaveBeenCalled();
    });
});

