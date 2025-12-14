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

async function tryExec(command: string): Promise<boolean> {
    try {
        await execAsync(command)
        return true
    } catch {
        return false
    }
}

export interface RouterConfig {
    providers?: Array<{
        name: string
        apiEndpoint: string
        apiKey?: string
        models?: Record<string, any>
    }>
    Providers?: Array<{
        name: string
        api_base_url: string
        api_key?: string
        models?: string[]
        transformer?: any
    }>
    router?: {
        default?: string
        background?: string
        think?: string
        longContext?: string
        webSearch?: string
        longContextThreshold?: number
    }
    Router?: {
        default?: string
        background?: string
        think?: string
        longContext?: string
        longContextThreshold?: number
        webSearch?: string
        image?: string
    }
    transformer?: Record<string, any>
    Transformers?: any[]
    proxy?: string
    PROXY_URL?: string
    logLevel?: string
    LOG_LEVEL?: string
    apiTimeout?: number
    API_TIMEOUT_MS?: string
}

export interface RouterDetectionResult {
    isInstalled: boolean
    executablePath: string | null
    configPath: string | null
    config: RouterConfig | null
    warnings?: string[]
    error?: string
    isServiceRunning?: boolean
    serviceError?: string
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
    const path = await findCcrExecutablePath()
    if (path) {
        return true
    }

    // Fallback to npx (no global install required)
    return tryExec('npx --yes @musistudio/claude-code-router --version')
}

/**
 * Get path to ccr executable
 */
export async function getCcrExecutablePath(): Promise<string | null> {
    const resolved = await findCcrExecutablePath()
    if (resolved) {
        return resolved
    }

    const locator = process.platform === 'win32' ? 'where ccr' : 'which ccr'

    try {
        const { stdout } = await execAsync(locator)
        const path = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0)

        if (path) {
            return path
        }
    } catch {
        // ignore, continue to fallbacks
    }

    // If the executable resolves in PATH, return the command name directly
    if (await tryExec('ccr --version')) {
        return 'ccr'
    }

    // Fallback to npx if not globally installed
    return 'npx'
}

/**
 * Find ccr executable across Windows/POSIX install locations
 */
async function findCcrExecutablePath(): Promise<string | null> {
    // Quick path: resolves via PATH when using the current shell
    if (await tryExec('ccr --version')) {
        return 'ccr'
    }

    // Platform-specific locator
    const locator = process.platform === 'win32' ? 'where ccr' : 'which ccr'
    try {
        const { stdout } = await execAsync(locator)
        const path = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0)
        if (path) {
            return path
        }
    } catch {
        // continue to additional checks
    }

    if (process.platform === 'win32') {
        // PowerShell discovery (covers modules/aliases)
        try {
            const { stdout } = await execAsync(
                'powershell -NoProfile -Command "Get-Command ccr | Select-Object -First 1 -ExpandProperty Source"'
            )
            const psPath = stdout.trim()
            if (psPath) {
                return psPath
            }
        } catch {
            // ignore and keep searching
        }

        const userProfile = process.env.USERPROFILE || homedir()
        const appData = process.env.APPDATA || join(userProfile, 'AppData', 'Roaming')
        const systemDrive = process.env.SystemDrive || 'C:'
        const possiblePaths = [
            join(appData, 'npm', 'ccr.cmd'),
            join(appData, 'npm', 'ccr.ps1'),
            join(userProfile, 'AppData', 'Local', 'pnpm', 'ccr.cmd'),
            join(userProfile, 'AppData', 'Local', 'pnpm', 'ccr.ps1'),
            // Git Bash / POSIX-style locations
            join(userProfile, 'AppData', 'Roaming', 'npm', 'ccr'),
            join(homedir(), '.npm-global', 'bin', 'ccr'),
            join(homedir(), 'bin', 'ccr'),
            // NVM for Windows default shim path
            join(systemDrive, 'nvm4w', 'nodejs', 'ccr.ps1'),
            join(systemDrive, 'nvm4w', 'nodejs', 'ccr.cmd')
        ]

        const found = possiblePaths.find((p) => existsSync(p))
        if (found) {
            return found
        }
    }

    return null
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
export function validateRouterConfig(config: RouterConfig): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = []
    const warnings: string[] = []

    // Check for providers (support both lowercase and uppercase)
    const providers = config.providers || config.Providers
    if (!providers || providers.length === 0) {
        warnings.push('No providers configured')
    }

    if (providers) {
        providers.forEach((provider, index) => {
            if (!provider.name) {
                warnings.push(`Provider at index ${index} missing name`)
            }
            // Check for apiEndpoint or api_base_url (handle both provider formats)
            const hasApiEndpoint = 'apiEndpoint' in provider ? !!provider.apiEndpoint :
                                 'api_base_url' in provider ? !!provider.api_base_url : false
            if (!hasApiEndpoint) {
                warnings.push(`Provider "${provider.name}" missing apiEndpoint/api_base_url`)
            }
        })
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings
    }
}

/**
 * Detect and validate Claude Code Router installation
 * @param configPath Optional custom config path
 * @param checkService If true, also check if the service is running
 */
export async function detectRouter(configPath?: string, checkService: boolean = false): Promise<RouterDetectionResult> {
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
    result.warnings = validation.warnings
    if (!validation.valid) {
        result.error = `Router config validation failed: ${validation.errors.join(', ')}`
        return result
    }

    // Optionally check service status
    if (checkService) {
        try {
            const { checkRouterServiceStatus } = await import('./routerService')
            const serviceStatus = await checkRouterServiceStatus()
            result.isServiceRunning = serviceStatus.isRunning
            if (!serviceStatus.isRunning && serviceStatus.error) {
                result.serviceError = serviceStatus.error
            }
        } catch (error) {
            logger.debug(`[routerDetection] Failed to check service status: ${error}`)
            result.serviceError = 'Could not check service status'
        }
    }

    logger.debug('[routerDetection] Claude Code Router detected and configured')
    return result
}

/**
 * Get ccr executable args for spawning
 * Returns the executable and args to use for spawning the router
 */
export function getCcrSpawnConfig(executablePath: string): { executable: string; args: string[] } {
    // If the executable is a PowerShell script, invoke via powershell so Windows can execute it
    if (executablePath.toLowerCase().endsWith('.ps1')) {
        return {
            executable: 'powershell',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executablePath, 'code']
        }
    }

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
