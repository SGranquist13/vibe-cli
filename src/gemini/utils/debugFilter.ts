/**
 * Debug Output Filter
 * 
 * Filters out Gemini CLI debug/info output that shouldn't be sent to mobile.
 */

/**
 * Check if a string looks like Gemini CLI debug/info output that should be filtered
 */
export function isGeminiDebugOutput(text: string): boolean {
    if (!text || text.length === 0) return true;
    
    return (
        // Debug prefixes
        /^\[?(DEBUG|INFO|TRACE|WARN)\]?\s/i.test(text) ||
        // Internal component logs
        text.includes('[MemoryDiscovery]') ||
        text.includes('[BfsFileSearch]') ||
        text.includes('[AgentRegistry]') ||
        // Progress indicators
        text.includes('Scanning [') ||
        text.includes('batch of') ||
        // Experiment/config loading
        text.includes('Experiments loaded') ||
        text.includes('experimentIds') ||
        text.includes('flagId') ||
        text.includes('floatValue') ||
        text.includes('stringValue') ||
        // Session info
        text.includes('Session ID:') ||
        // Log flushing
        text.includes('Flushing log events') ||
        text.includes('Clearcut') ||
        // Credentials
        text.includes('cached credentials') ||
        text.includes('Loaded cached') ||
        // Various startup messages
        text.startsWith('Loading') ||
        text.startsWith('Loaded') ||
        text.startsWith('Found readable') ||
        text.startsWith('Searching for') ||
        text.startsWith('Determined project') ||
        text.startsWith('Initialized with') ||
        // JSON fragments (partial objects/arrays)
        /^\s*[\[\{]/.test(text) ||  // Lines starting with [ or {
        /^\s*\d+,?\s*$/.test(text) || // Lines that are just numbers
        /^\s*[\]\}],?\s*$/.test(text) // Lines that are just closing brackets
    );
}
