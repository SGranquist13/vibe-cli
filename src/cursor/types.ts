/**
 * Cursor CLI Integration Types
 * 
 * Type definitions for Cursor CLI (cursor-agent) integration.
 * This module is separate from Claude, Codex, and Gemini to maintain separation of concerns.
 */

/**
 * Cursor session configuration
 */
export interface CursorSessionConfig {
    prompt?: string; // Optional - if not provided, cursor-agent runs in interactive mode
    model?: string;
    cwd?: string;
    mcpServers?: Record<string, any>;
    outputFormat?: 'text' | 'json' | 'stream-json';
    // Add other Cursor-specific config options as needed
}

/**
 * Cursor tool response structure
 */
export interface CursorToolResponse {
    content?: Array<{
        type: string;
        text?: string;
        [key: string]: any;
    }>;
    isError?: boolean;
    meta?: {
        sessionId?: string;
        conversationId?: string;
        [key: string]: any;
    };
    [key: string]: any;
}

/**
 * Cursor message types
 */
export type CursorMessageType = 
    | 'message'
    | 'tool-call'
    | 'tool-call-result'
    | 'thinking'
    | 'error'
    | 'system'
    | 'assistant'
    | 'done';

/**
 * Cursor message structure
 */
export interface CursorMessage {
    type: CursorMessageType;
    id: string;
    message?: string;
    name?: string;
    callId?: string;
    input?: any;
    output?: any;
    [key: string]: any;
}

/**
 * Permission result from mobile app
 */
export interface CursorPermissionResult {
    decision: 'approved' | 'denied' | 'approved_for_session' | 'abort';
    reason?: string;
    allowTools?: string[];
}




