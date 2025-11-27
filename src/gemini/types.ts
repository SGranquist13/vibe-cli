/**
 * Gemini CLI Integration Types
 * 
 * Type definitions for Gemini CLI integration.
 * This module is separate from Claude and Codex to maintain separation of concerns.
 */

import { z } from 'zod';

/**
 * Gemini session configuration
 */
export interface GeminiSessionConfig {
    prompt?: string; // Optional - if not provided, Gemini CLI runs in interactive mode
    model?: string;
    cwd?: string;
    mcpServers?: Record<string, any>;
    // Add other Gemini-specific config options as needed
}

/**
 * Gemini tool response structure
 */
export interface GeminiToolResponse {
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
 * Gemini message types
 */
export type GeminiMessageType = 
    | 'message'
    | 'tool-call'
    | 'tool-call-result'
    | 'thinking'
    | 'error'
    | 'system';

/**
 * Gemini message structure
 */
export interface GeminiMessage {
    type: GeminiMessageType;
    id: string;
    message?: string;
    name?: string;
    callId?: string;
    input?: any;
    output?: any;
    [key: string]: any;
}

