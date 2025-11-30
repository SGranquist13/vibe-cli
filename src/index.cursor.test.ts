import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCursor = vi.fn();
const authAndSetupMachineIfNeeded = vi.fn();

const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

vi.mock('@/cursor/runCursor', () => ({ runCursor }));
vi.mock('./ui/auth', () => ({ authAndSetupMachineIfNeeded }));
vi.mock('./ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        infoDeveloper: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        logFilePath: '/tmp/vibe.log'
    },
    getLatestDaemonLog: vi.fn().mockResolvedValue(null)
}));

describe('vibe CLI cursor command', () => {
    const originalArgv = [...process.argv];
    const originalExit = process.exit;

    beforeEach(() => {
        runCursor.mockReset();
        authAndSetupMachineIfNeeded.mockReset();
    });

    afterEach(() => {
        process.argv = [...originalArgv];
        process.exit = originalExit;
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('invokes runCursor with credentials and startedBy option', async () => {
        runCursor.mockResolvedValue(undefined);
        authAndSetupMachineIfNeeded.mockResolvedValue({
            credentials: { token: 'fake' }
        });

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        process.argv = ['node', 'vibe', 'cursor', '--started-by', 'daemon'];

        await import('./index');
        await flushAsync();

        expect(runCursor).toHaveBeenCalledWith({
            credentials: { token: 'fake' },
            startedBy: 'daemon'
        });
        expect(exitSpy).not.toHaveBeenCalled();
    });
});

