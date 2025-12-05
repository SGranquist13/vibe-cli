/**
 * Message Handler for Gemini CLI
 * 
 * Handles message processing and transformation from Gemini CLI output
 * to Vibe session messages.
 */

import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { ApiSessionClient } from '@/api/apiSession';
import { isGeminiDebugOutput } from './debugFilter';

// Track streaming state
let streamingBuffer: string = '';
let isStreaming: boolean = false;

/**
 * Process a message from Gemini CLI and send to session
 */
export function handleGeminiMessage(
    msg: any,
    session: ApiSessionClient,
    options: {
        onThinkingChange?: (thinking: boolean) => void;
        onComplete?: () => void;
        shouldSkipMessage?: (messageText: string) => boolean;
        onRateLimitError?: (errorMessage: string) => boolean; // Return true to suppress
    } = {}
): void {
    const msgType = msg.type || msg.event || 'unknown';
    
    switch (msgType) {
        case 'message':
        case 'assistant':
        case 'assistant_message':
            handleTextMessage(msg, session, options.shouldSkipMessage);
            break;
            
        case 'tool_use':
        case 'tool_call':
        case 'function_call':
            flushStreamingBuffer(session, options.shouldSkipMessage);
            handleToolCall(msg, session);
            break;
            
        case 'tool_result':
        case 'function_result':
            flushStreamingBuffer(session, options.shouldSkipMessage);
            handleToolResult(msg, session);
            break;
            
        case 'thinking':
        case 'reasoning':
            handleThinking(msg, session, options);
            break;
            
        case 'error':
            handleError(msg, session, options);
            break;
            
        case 'system':
        case 'system_message':
            handleSystemMessage(msg, session);
            break;
            
        case 'done':
        case 'complete':
        case 'finished':
            flushStreamingBuffer(session, options.shouldSkipMessage);
            handleComplete(session, options);
            break;
            
        case 'result':
            flushStreamingBuffer(session, options.shouldSkipMessage);
            handleResult(msg, session, options);
            break;
            
        case 'progress':
        case 'status':
        case 'log':
        case 'debug':
        case 'info':
            // Progress updates - just log
            logger.debug(`[Gemini] Progress: ${msg.message || msg.text || JSON.stringify(msg)}`);
            break;
            
        default:
            handleUnknownMessage(msg, session);
            break;
    }
}

function flushStreamingBuffer(session: ApiSessionClient, shouldSkip?: (text: string) => boolean): void {
    if (isStreaming && streamingBuffer.length > 0) {
        // Check if we should skip this message (e.g., echo detection)
        if (shouldSkip && shouldSkip(streamingBuffer)) {
            streamingBuffer = '';
            isStreaming = false;
            return;
        }
        
        session.sendGeminiMessage({
            type: 'message',
            message: streamingBuffer,
            id: randomUUID()
        });
        streamingBuffer = '';
        isStreaming = false;
    }
}

function handleTextMessage(msg: any, session: ApiSessionClient, shouldSkip?: (text: string) => boolean): void {
    const messageText = msg.message || msg.text || msg.content || '';
    const isDelta = msg.delta === true;
    
    if (isDelta) {
        // Streaming delta - accumulate
        isStreaming = true;
        streamingBuffer += messageText;
    } else {
        // Complete message - flush buffer first
        flushStreamingBuffer(session, shouldSkip);
        
        // Then send the new message (checking for echo)
        if (messageText.length > 0) {
            if (shouldSkip && shouldSkip(messageText)) {
                return;
            }
            
            session.sendGeminiMessage({
                type: 'message',
                message: messageText,
                id: randomUUID()
            });
        }
    }
}

function handleToolCall(msg: any, session: ApiSessionClient): void {
    session.sendGeminiMessage({
        type: 'tool-call',
        name: msg.tool_name || msg.name || msg.function_name || 'unknown',
        callId: msg.tool_id || msg.toolId || msg.call_id || msg.id || randomUUID(),
        input: msg.parameters || msg.input || msg.arguments || {},
        id: randomUUID()
    });
}

function handleToolResult(msg: any, session: ApiSessionClient): void {
    session.sendGeminiMessage({
        type: 'tool-call-result',
        callId: msg.tool_id || msg.toolId || msg.call_id || msg.id || randomUUID(),
        output: msg.output || msg.result || {},
        is_error: msg.status === 'error' || msg.status === 'failed' || false,
        id: randomUUID()
    });
}

function handleThinking(msg: any, session: ApiSessionClient, options: { onThinkingChange?: (thinking: boolean) => void }): void {
    if (options.onThinkingChange) {
        options.onThinkingChange(true);
    }
    
    if (msg.text || msg.content) {
        session.sendGeminiMessage({
            type: 'thinking',
            message: msg.text || msg.content || '',
            id: randomUUID()
        });
    }
}

function handleError(msg: any, session: ApiSessionClient, options: { onRateLimitError?: (errorMessage: string) => boolean } = {}): void {
    const errorText = msg.message || msg.error || '';
    const isRateLimit = msg.isRateLimit || false;
    
    if (errorText.length > 0 && !isGeminiDebugOutput(errorText)) {
        // Check if this is a rate limit error that's being retried
        if (isRateLimit || errorText.includes('429') || 
            errorText.includes('rateLimitExceeded') ||
            errorText.includes('RESOURCE_EXHAUSTED') ||
            errorText.includes('Resource exhausted')) {
            
            // Check if error handler wants to suppress this (e.g., it's being retried)
            if (options.onRateLimitError && options.onRateLimitError(errorText)) {
                logger.debug('[Gemini] Rate limit error suppressed (retry in progress)');
                return; // Suppress the error
            }
        }
        
        let finalMessage = errorText;
        
        if (isRateLimit || errorText.includes('429') || 
            errorText.includes('rateLimitExceeded') ||
            errorText.includes('RESOURCE_EXHAUSTED') ||
            errorText.includes('Resource exhausted')) {
            
            // Extract error details if it's JSON
            try {
                // Try to find JSON in the error text
                const jsonMatch = errorText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const errorObj = JSON.parse(jsonMatch[0]);
                    const errorDetails = errorObj.error || errorObj;
                    const errorMessage = errorDetails.message || errorDetails.code || errorText;
                    
                    finalMessage = `⚠️ Rate Limit Exceeded (429)\n\n` +
                                 `${errorMessage}\n\n` +
                                 `The Gemini API is temporarily rate-limited. The request will be retried automatically with backoff.\n` +
                                 `If this persists, please:\n` +
                                 `• Wait a few minutes before trying again\n` +
                                 `• Check your Google Cloud quota limits\n` +
                                 `• See: https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429`;
                } else {
                    finalMessage = `⚠️ Rate Limit Exceeded (429)\n\n` +
                                 `${errorText}\n\n` +
                                 `The Gemini API is temporarily rate-limited. The request will be retried automatically with backoff.\n` +
                                 `Please wait a moment and try again.`;
                }
            } catch {
                // If parsing fails, use a simpler message
                finalMessage = `⚠️ Rate Limit Exceeded (429)\n\n` +
                             `${errorText}\n\n` +
                             `The Gemini API is temporarily rate-limited. The request will be retried automatically with backoff.\n` +
                             `Please wait a moment and try again.`;
            }
        }
        
        session.sendGeminiMessage({
            type: 'error',
            message: finalMessage,
            id: randomUUID()
        });
    }
}

function handleSystemMessage(msg: any, session: ApiSessionClient): void {
    session.sendGeminiMessage({
        type: 'system',
        message: msg.message || msg.text || '',
        id: randomUUID()
    });
}

function handleComplete(session: ApiSessionClient, options: { onThinkingChange?: (thinking: boolean) => void; onComplete?: () => void }): void {
    if (options.onThinkingChange) {
        options.onThinkingChange(false);
    }
    if (options.onComplete) {
        options.onComplete();
    }
}

function handleResult(msg: any, session: ApiSessionClient, options: { onThinkingChange?: (thinking: boolean) => void; onComplete?: () => void }): void {
    if (options.onThinkingChange) {
        options.onThinkingChange(false);
    }
    
    // Extract and send usage statistics if available
    if (msg.stats) {
        try {
            const usage = {
                input_tokens: msg.stats.input_tokens || 0,
                output_tokens: msg.stats.output_tokens || 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0
            };
            session.sendUsageData(usage);
            logger.debug(`[Gemini] Sent usage stats: ${JSON.stringify(usage)}`);
        } catch (error) {
            logger.debug('[Gemini] Failed to send usage data:', error);
        }
    }
    
    if (options.onComplete) {
        options.onComplete();
    }
}

function handleUnknownMessage(msg: any, session: ApiSessionClient): void {
    logger.debug(`[Gemini] Unknown message type: ${msg.type || msg.event || 'unknown'}`);
    const unknownText = msg.message || msg.text || msg.content;
    
    if (typeof unknownText === 'string' && unknownText.length > 0) {
        if (!isGeminiDebugOutput(unknownText)) {
            session.sendGeminiMessage({
                type: 'message',
                message: unknownText,
                id: randomUUID()
            });
        }
    }
}
