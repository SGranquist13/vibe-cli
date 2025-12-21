/**
 * Claude Code Router service management utilities
 * Handles checking service status and starting the router service
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '@/lib'
import { getCcrExecutablePath } from './routerDetection'
import { spawn } from 'node:child_process'

const execAsync = promisify(exec)

export interface RouterServiceStatus {
    isRunning: boolean
    error?: string
    details?: string
}

/**
 * Check if port 3456 is listening (CCR service port)
 * Uses net.connect for more reliable port detection
 */
async function checkPort3456(): Promise<boolean> {
    try {
        const net = await import('net')
        return new Promise((resolve) => {
            const socket = new net.Socket()
            let resolved = false
            
            const cleanup = () => {
                if (!resolved) {
                    resolved = true
                    try {
                        socket.destroy()
                    } catch {
                        // Ignore cleanup errors
                    }
                }
            }
            
            // Set timeout
            const timeout = setTimeout(() => {
                cleanup()
                resolve(false)
            }, 3000) // Increased to 3 seconds
            
            socket.on('connect', () => {
                clearTimeout(timeout)
                cleanup()
                resolve(true)
            })
            
            socket.on('error', () => {
                clearTimeout(timeout)
                cleanup()
                resolve(false)
            })
            
            // Try to connect
            try {
                socket.connect(3456, '127.0.0.1')
            } catch {
                clearTimeout(timeout)
                cleanup()
                resolve(false)
            }
        })
    } catch {
        return false
    }
}

/**
 * Check port 3456 with retries (service may take time to start)
 */
async function checkPort3456WithRetries(maxRetries: number = 3, delayMs: number = 1000): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
        const isRunning = await checkPort3456()
        if (isRunning) {
            return true
        }
        
        // Wait before retry (except on last attempt)
        if (i < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs))
        }
    }
    
    return false
}

/**
 * Check if CCR service is running by executing `ccr status` and checking port
 */
export async function checkRouterServiceStatus(): Promise<RouterServiceStatus> {
    try {
        const executablePath = await getCcrExecutablePath()
        if (!executablePath) {
            return {
                isRunning: false,
                error: 'CCR executable not found'
            }
        }

        // First, try to check port 3456 directly (most reliable) with retries
        const portCheck = await checkPort3456WithRetries(3, 1000)
        if (portCheck) {
            logger.debug('[routerService] Port 3456 is listening - service is running')
            return {
                isRunning: true,
                details: 'Service detected on port 3456'
            }
        }
        
        logger.debug('[routerService] Port 3456 check failed, trying ccr status command...')

        // If port check fails, try ccr status command
        let command: string
        if (executablePath.toLowerCase().endsWith('.ps1')) {
            // PowerShell script - execute via PowerShell
            command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "& '${executablePath}' status"`
        } else if (executablePath === 'npx') {
            command = 'npx --yes @musistudio/claude-code-router status'
        } else {
            command = `${executablePath} status`
        }

        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout: 5000, // 5 second timeout
                maxBuffer: 1024 * 1024 // 1MB buffer
            })

            // Parse output to determine if service is running
            const output = (stdout || stderr || '').toLowerCase()
            logger.debug(`[routerService] ccr status output: ${output.substring(0, 200)}`)
            
            // More lenient detection - if command succeeded and we don't see explicit "not running", assume it's running
            const hasRunning = output.includes('running') || output.includes('active') || output.includes('listening') || 
                               output.includes('started') || output.includes('ready') || output.includes('port 3456')
            const hasStopped = output.includes('not running') || output.includes('stopped') || 
                              (output.includes('error') && !output.includes('no error'))
            
            // If we see explicit "running" indicators, trust that
            if (hasRunning && !hasStopped) {
                logger.debug('[routerService] Service detected as running from ccr status command')
                return {
                    isRunning: true,
                    details: stdout || stderr || 'Service status checked'
                }
            }
            
            // If we see explicit "stopped" indicators, service is not running
            if (hasStopped) {
                logger.debug('[routerService] Service detected as not running from ccr status command')
                return {
                    isRunning: false,
                    error: 'Service is not running',
                    details: stdout || stderr || 'Service status checked'
                }
            }
            
            // If command succeeded but output is ambiguous, try port check one more time
            // (service might have just started)
            logger.debug('[routerService] Ambiguous output, retrying port check...')
            const retryPortCheck = await checkPort3456WithRetries(2, 500)
            if (retryPortCheck) {
                logger.debug('[routerService] Service detected via port check after ambiguous command output')
                return {
                    isRunning: true,
                    details: 'Service detected on port 3456 (after retry)'
                }
            }
            
            // Ambiguous output and port check failed - default to not running
            logger.debug('[routerService] Could not determine service status from command output or port check')
            return {
                isRunning: false,
                error: 'Could not determine service status from command output',
                details: stdout || stderr || 'Service status checked'
            }
        } catch (error: any) {
            // Command failed - service likely not running
            const errorMessage = error.message || String(error)
            logger.debug(`[routerService] Status check failed: ${errorMessage}`)
            
            // If it's a timeout or command not found, service is not running
            if (errorMessage.includes('timeout') || errorMessage.includes('ENOENT') || errorMessage.includes('command not found')) {
                return {
                    isRunning: false,
                    error: 'Service not running or command failed',
                    details: errorMessage
                }
            }

            // Other errors - default to not running since port check also failed
            return {
                isRunning: false,
                error: 'Could not determine service status',
                details: errorMessage
            }
        }
    } catch (error: any) {
        logger.debug(`[routerService] Failed to check service status: ${error}`)
        return {
            isRunning: false,
            error: error.message || 'Unknown error checking service status'
        }
    }
}

/**
 * Start the CCR service by executing `ccr start`
 */
export async function startRouterService(): Promise<{ success: boolean; error?: string; details?: string }> {
    try {
        const executablePath = await getCcrExecutablePath()
        if (!executablePath) {
            return {
                success: false,
                error: 'CCR executable not found. Install with: npm install -g @musistudio/claude-code-router'
            }
        }

        logger.debug(`[routerService] Starting CCR service with executable: ${executablePath}`)

        // Build command based on executable type
        let executable: string
        let args: string[]

        if (executablePath.toLowerCase().endsWith('.ps1')) {
            // PowerShell script - execute via PowerShell
            executable = 'powershell'
            args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executablePath, 'start']
        } else if (executablePath === 'npx') {
            executable = 'npx'
            args = ['--yes', '@musistudio/claude-code-router', 'start']
        } else {
            executable = executablePath
            args = ['start']
        }

        // Spawn detached process so it runs in background
        const child = spawn(executable, args, {
            detached: true,
            stdio: 'ignore',
            shell: process.platform === 'win32' // Use shell on Windows for better compatibility
        })

        // Handle immediate errors
        child.on('error', (error) => {
            logger.debug(`[routerService] Failed to spawn service start process: ${error.message}`)
        })

        // Unref so parent process can exit independently
        child.unref()

        // Wait a moment for process to start
        await new Promise(resolve => setTimeout(resolve, 1500))

        // Give service a moment to start, then verify it's running
        await new Promise(resolve => setTimeout(resolve, 2000))
        const status = await checkRouterServiceStatus()

        if (status.isRunning) {
            logger.debug('[routerService] CCR service started successfully')
            return {
                success: true,
                details: 'Service started and verified running'
            }
        } else {
            // Service might be starting, give it more time
            await new Promise(resolve => setTimeout(resolve, 3000))
            const retryStatus = await checkRouterServiceStatus()
            
            if (retryStatus.isRunning) {
                logger.debug('[routerService] CCR service started successfully (after retry)')
                return {
                    success: true,
                    details: 'Service started and verified running'
                }
            }

            return {
                success: false,
                error: 'Service start command executed but service is not running',
                details: status.error || 'Service status check failed'
            }
        }
    } catch (error: any) {
        logger.debug(`[routerService] Failed to start service: ${error}`)
        return {
            success: false,
            error: error.message || 'Unknown error starting service'
        }
    }
}

/**
 * Ensure CCR service is running - check status and start if needed
 */
export async function ensureRouterServiceRunning(): Promise<{ isRunning: boolean; wasStarted: boolean; error?: string }> {
    // Check current status
    const status = await checkRouterServiceStatus()
    
    if (status.isRunning) {
        logger.debug('[routerService] CCR service is already running')
        return {
            isRunning: true,
            wasStarted: false
        }
    }

    // Service is not running, attempt to start it
    logger.debug('[routerService] CCR service is not running, attempting to start...')
    const startResult = await startRouterService()

    if (startResult.success) {
        return {
            isRunning: true,
            wasStarted: true
        }
    }

    // Failed to start
    return {
        isRunning: false,
        wasStarted: false,
        error: startResult.error || 'Failed to start service'
    }
}

