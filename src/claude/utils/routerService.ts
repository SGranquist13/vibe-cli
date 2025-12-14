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
 */
async function checkPort3456(): Promise<boolean> {
    try {
        const http = await import('http')
        return new Promise((resolve) => {
            try {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: 3456,
                    path: '/',
                    method: 'GET',
                    timeout: 2000
                }, (res) => {
                    // Any response means service is running
                    resolve(true)
                })
                
                req.on('error', () => {
                    resolve(false)
                })
                
                req.on('timeout', () => {
                    req.destroy()
                    resolve(false)
                })
                
                req.end()
            } catch {
                resolve(false)
            }
        })
    } catch {
        return false
    }
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

        // First, try to check port 3456 directly (most reliable)
        const portCheck = await checkPort3456()
        if (portCheck) {
            logger.debug('[routerService] Port 3456 is listening - service is running')
            return {
                isRunning: true,
                details: 'Service detected on port 3456'
            }
        }

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
            const hasRunning = output.includes('running') || output.includes('active') || output.includes('listening')
            const hasStopped = output.includes('not running') || output.includes('stopped') || output.includes('error')
            
            // If we see explicit "running" indicators, trust that
            if (hasRunning && !hasStopped) {
                return {
                    isRunning: true,
                    details: stdout || stderr || 'Service status checked'
                }
            }
            
            // If we see explicit "stopped" indicators, service is not running
            if (hasStopped) {
                return {
                    isRunning: false,
                    error: 'Service is not running',
                    details: stdout || stderr || 'Service status checked'
                }
            }

            // Ambiguous output - default to not running if port check also failed
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

