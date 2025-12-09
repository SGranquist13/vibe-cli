/**
 * Claude Code Router detection and configuration utilities
 * Handles detection of installed router and configuration validation
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '@/lib'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface RouterConfig {
    providers?: Array<{
        name: string
        apiEndpoint: string
        apiKey?: string
        models?: Record<string, any>
    }>
    router?: {
        default?: string
        background?: string
        think?: string
        longContext?: string
        webSearch?: string
        longContextThreshold?: number
    }
    transformer?: Record<string, any>
    proxy?: string
    logLevel?: string
    apiTimeout?: number
}

export interface RouterDetectionResult {
    isInstalled: boolean
    executablePath: string | null
    configPath: string | null
    config: RouterConfig | null
    error?: string
}

/**
 * Get default router config path
 */
export function getDefaultRouterConfigPath(): string {
    return join(homedir(), '.claude-code-router', 'config.json')
}

/**
 * Check if ccr (claude-code-router) is installed
 */
export async function isCcrInstalled(): Promise<boolean> {
    try {
        await execAsync('which ccr')
        return true
    } catch {
        try {
            // Try npx as fallback
            await execAsync('npx --yes @musistudio/claude-code-router --version')
            return true
        } catch {
            return false
        }
    }
}

/**
 * Get path to ccr executable
 */
export async function getCcrExecutablePath(): Promise<string | null> {
    try {
        const { stdout } = await execAsync('which ccr')
        return stdout.trim()
    } catch {
        // Return npx command as fallback
        return 'npx'
    }
}

/**
 * Read and parse router configuration
 */
export async function readRouterConfig(configPath?: string): Promise<RouterConfig | null> {
    const path = configPath || getDefaultRouterConfigPath()

    if (!existsSync(path)) {
        logger.debug(`[routerDetection] Router config not found at ${path}`)
        return null
    }

    try {
        const content = await readFile(path, 'utf-8')
        const config = JSON.parse(content) as RouterConfig
        logger.debug(`[routerDetection] Router config loaded from ${path}`)
        return config
    } catch (error) {
        logger.debug(`[routerDetection] Failed to parse router config: ${error}`)
        return null
    }
}

/**
 * Validate router configuration
 */
export function validateRouterConfig(config: RouterConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!config.providers || config.providers.length === 0) {
        errors.push('No providers configured')
    }

    if (config.providers) {
        config.providers.forEach((provider, index) => {
            if (!provider.name) {
                errors.push(`Provider at index ${index} missing name`)
            }
            if (!provider.apiEndpoint) {
                errors.push(`Provider "${provider.name}" missing apiEndpoint`)
            }
        })
    }

    return {
        valid: errors.length === 0,
        errors
    }
}

/**
 * Detect and validate Claude Code Router installation
 */
export async function detectRouter(configPath?: string): Promise<RouterDetectionResult> {
    const result: RouterDetectionResult = {
        isInstalled: false,
        executablePath: null,
        configPath: null,
        config: null
    }

    // Check if ccr is installed
    const installed = await isCcrInstalled()
    if (!installed) {
        result.error = 'Claude Code Router (ccr) not found. Install with: npm install -g @musistudio/claude-code-router'
        return result
    }

    result.isInstalled = true
    result.executablePath = await getCcrExecutablePath()

    // Try to read config
    const path = configPath || getDefaultRouterConfigPath()
    result.configPath = path
    result.config = await readRouterConfig(path)

    if (!result.config) {
        result.error = `Router config not found at ${path}. Run 'ccr model' to configure.`
        return result
    }

    // Validate config
    const validation = validateRouterConfig(result.config)
    if (!validation.valid) {
        result.error = `Router config validation failed: ${validation.errors.join(', ')}`
        return result
    }

    logger.debug('[routerDetection] Claude Code Router detected and configured')
    return result
}

/**
 * Get ccr executable args for spawning
 * Returns the executable and args to use for spawning the router
 */
export function getCcrSpawnConfig(executablePath: string): { executable: string; args: string[] } {
    if (executablePath === 'npx') {
        return {
            executable: 'npx',
            args: ['--yes', '@musistudio/claude-code-router', 'code']
        }
    }

    return {
        executable: executablePath,
        args: ['code']
    }
}
