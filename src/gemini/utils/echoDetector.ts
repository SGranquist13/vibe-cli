/**
 * Echo Detection Utility
 * 
 * Detects if Gemini's first response is an echo of the user's message.
 * This helps filter out duplicate/echo responses that Gemini sometimes returns.
 */

import { logger } from '@/ui/logger';

/**
 * Simple similarity check between two strings
 */
function calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    if (longer.length === 0) return 1.0;
    
    // Simple character overlap check
    let matches = 0;
    const minLen = Math.min(longer.length, shorter.length);
    for (let i = 0; i < minLen; i++) {
        if (longer[i] === shorter[i]) matches++;
    }
    return matches / longer.length;
}

/**
 * Check if content appears to be an echo of the user's message
 */
export function isEchoOfUserMessage(content: string, userMessage: string | null): boolean {
    if (!userMessage || !content) return false;
    
    const normalizedContent = content.trim();
    const normalizedUserMessage = userMessage.trim();
    
    // Exact match
    if (normalizedContent === normalizedUserMessage) {
        logger.debug('[Gemini] Exact echo match detected');
        return true;
    }
    
    // Check if content starts with significant portion of user message
    if (normalizedUserMessage.length > 10) {
        const prefixLength = Math.min(100, Math.floor(normalizedUserMessage.length * 0.8));
        const userPrefix = normalizedUserMessage.substring(0, prefixLength).trim();
        
        if (normalizedContent.startsWith(userPrefix)) {
            const lengthRatio = normalizedContent.length / normalizedUserMessage.length;
            if (lengthRatio >= 0.8 && lengthRatio <= 1.2) {
                logger.debug(`[Gemini] Prefix echo match detected (ratio: ${lengthRatio.toFixed(2)})`);
                return true;
            }
        }
    }
    
    // For short messages, check similarity
    if (normalizedUserMessage.length < 50 && normalizedContent.length < 50) {
        const similarity = calculateSimilarity(normalizedContent, normalizedUserMessage);
        if (similarity > 0.8) {
            logger.debug(`[Gemini] Similarity echo match detected (similarity: ${similarity.toFixed(2)})`);
            return true;
        }
    }
    
    return false;
}
