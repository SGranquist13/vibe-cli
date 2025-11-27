/**
 * Global configuration for vibe CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'

class Configuration {
  public readonly serverUrl: string
  public readonly webappUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly vibeHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  constructor() {
    // Server configuration - priority: parameter > environment > default
    // Default to localhost for local development
    this.serverUrl = process.env.VIBE_SERVER_URL || 'http://localhost:3005'
    this.webappUrl = process.env.VIBE_WEBAPP_URL || 'http://localhost:8081'

    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: VIBE_HOME_DIR env > default home dir
    if (process.env.VIBE_HOME_DIR) {
      // Expand ~ to home directory if present
      const homeDir = process.env.VIBE_HOME_DIR
      if (homeDir) {
        const expandedPath = homeDir.replace(/^~/, homedir())
        this.vibeHomeDir = expandedPath
      } else {
        this.vibeHomeDir = join(homedir(), '.vibe')
      }
    } else {
      this.vibeHomeDir = join(homedir(), '.vibe')
    }

    this.logsDir = join(this.vibeHomeDir, 'logs')
    this.settingsFile = join(this.vibeHomeDir, 'settings.json')
    this.privateKeyFile = join(this.vibeHomeDir, 'access.key')
    this.daemonStateFile = join(this.vibeHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.vibeHomeDir, 'daemon.state.json.lock')

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes((process.env.VIBE_EXPERIMENTAL)?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes((process.env.VIBE_DISABLE_CAFFEINATE)?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    if (!existsSync(this.vibeHomeDir)) {
      mkdirSync(this.vibeHomeDir, { recursive: true })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }
}

export const configuration: Configuration = new Configuration()
