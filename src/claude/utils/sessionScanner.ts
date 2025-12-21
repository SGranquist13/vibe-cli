import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
}) {
    logger.debug(`[SESSION_SCANNER] Creating scanner with sessionId: ${opts.sessionId}, workingDirectory: ${opts.workingDirectory}`);

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);
    logger.debug(`[SESSION_SCANNER] Project directory: ${projectDir}`);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedMessageKeys = new Set<string>();

    // Mark existing messages as processed
    if (opts.sessionId) {
        logger.debug(`[SESSION_SCANNER] Initial session ID provided: ${opts.sessionId}, marking existing messages as processed`);
        let messages = await readSessionLog(projectDir, opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Found ${messages.length} existing messages to mark as processed`);
        for (let m of messages) {
            processedMessageKeys.add(messageKey(m));
        }
    } else {
        logger.debug(`[SESSION_SCANNER] No initial session ID, will wait for onNewSession to be called`);
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {
        // logger.debug(`[SESSION_SCANNER] Syncing...`);

        // Collect session ids
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            sessions.push(p);
        }
        if (currentSessionId) {
            sessions.push(currentSessionId);
        }

        // Process sessions
        for (let session of sessions) {
            const messages = await readSessionLog(projectDir, session);
            logger.debug(`[SESSION_SCANNER] Processing ${messages.length} messages from session ${session}`);
            for (let file of messages) {
                let key = messageKey(file);
                if (processedMessageKeys.has(key)) {
                    logger.debug(`[SESSION_SCANNER] Message ${key} already processed, skipping`);
                    continue;
                }
                processedMessageKeys.add(key);
                logger.debug(`[SESSION_SCANNER] Processing new message type: ${file.type}, key: ${key}`);
                opts.onMessage(file);
            }
        }

        // Move pending sessions to finished sessions
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers
        for (let p of sessions) {
            if (!watchers.has(p)) {
                watchers.set(p, startFileWatcher(join(projectDir, `${p}.jsonl`), () => { sync.invalidate(); }));
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        onNewSession: (sessionId: string) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, forcing sync`);
                // Force sync even if it's the same session to pick up any new messages
                sync.invalidate();
                return;
            }
            if (finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, but forcing sync to check for new messages`);
                // Even if finished, we should check for new messages
                sync.invalidate();
                return;
            }
            if (pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, promoting to current and syncing`);
                // Promote pending session to current
                pendingSessions.delete(sessionId);
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}, previous: ${currentSessionId}`)
            currentSessionId = sessionId;
            // Ensure file watcher is set up and force immediate sync
            sync.invalidate();
        },
        forceSync: () => {
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

async function readSessionLog(projectDir: string, sessionId: string): Promise<RawJSONLines[]> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await readFile(expectedSessionFile, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
        return [];
    }
    let lines = file.split('\n');
    let messages: RawJSONLines[] = [];
    for (let l of lines) {
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) { // We can't deduplicate this message so we have to skip it
                logger.debugLargeJson(`[SESSION_SCANNER] Failed to parse message`, message)
                continue;
            }
            messages.push(parsed.data);
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return messages;
}