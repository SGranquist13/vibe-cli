/**
 * Router command handlers
 * Manages Claude Code Router configuration and settings
 */

import chalk from 'chalk';
import { readSettings, updateSettings } from '@/persistence';
import { detectRouter, getDefaultRouterConfigPath } from '@/claude/utils/routerDetection';
import { logger } from '@/lib';

export async function handleRouterCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (subcommand === 'enable') {
        await enableRouter(args.slice(1));
    } else if (subcommand === 'disable') {
        await disableRouter();
    } else if (subcommand === 'status') {
        await showRouterStatus();
    } else if (subcommand === 'config') {
        await showRouterConfig(args.slice(1));
    } else {
        showRouterHelp();
    }
}

async function enableRouter(args: string[]): Promise<void> {
    let configPath: string | undefined = undefined;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--config-path' && i + 1 < args.length) {
            configPath = args[++i];
        }
    }

    console.log(chalk.blue('🔍 Detecting Claude Code Router...'));

    // Detect router
    const detection = await detectRouter(configPath);

    if (!detection.isInstalled) {
        console.log(chalk.red('✗ Claude Code Router not found'));
        console.log(chalk.yellow('\nTo install Claude Code Router:'));
        console.log(chalk.cyan('  npm install -g @musistudio/claude-code-router'));
        console.log(chalk.yellow('\nThen configure it with:'));
        console.log(chalk.cyan('  ccr model'));
        process.exit(1);
    }

    if (detection.error) {
        console.log(chalk.red(`✗ Router configuration issue: ${detection.error}`));
        console.log(chalk.yellow('\nRun the following to configure:'));
        console.log(chalk.cyan('  ccr model'));
        process.exit(1);
    }

    // Enable router
    await updateSettings((settings) => ({
        ...settings,
        router: {
            enabled: true,
            configPath: configPath || detection.configPath || undefined
        }
    }));

    console.log(chalk.green('✓ Claude Code Router enabled'));
    console.log(chalk.gray(`  Executable: ${detection.executablePath}`));
    console.log(chalk.gray(`  Config: ${detection.configPath}`));

    if (detection.config) {
        const providers = detection.config.providers || [];
        if (providers.length > 0) {
            console.log(chalk.gray(`  Providers: ${providers.map(p => p.name).join(', ')}`));
        }
    }

    console.log(chalk.yellow('\nNote: The router will be used for all future Claude sessions.'));
}

async function disableRouter(): Promise<void> {
    await updateSettings((settings) => ({
        ...settings,
        router: {
            enabled: false
        }
    }));

    console.log(chalk.green('✓ Claude Code Router disabled'));
    console.log(chalk.gray('  Default Claude Code will be used'));
}

async function showRouterStatus(): Promise<void> {
    const settings = await readSettings();
    const routerEnabled = settings.router?.enabled ?? false;

    console.log(chalk.bold('Claude Code Router Status:\n'));

    if (routerEnabled) {
        console.log(chalk.green('✓ Enabled'));

        const detection = await detectRouter(settings.router?.configPath);

        if (detection.isInstalled) {
            console.log(chalk.gray(`  Executable: ${detection.executablePath}`));
            console.log(chalk.gray(`  Config: ${detection.configPath}`));

            if (detection.config) {
                const providers = detection.config.providers || [];
                if (providers.length > 0) {
                    console.log(chalk.gray(`  Providers: ${providers.map(p => p.name).join(', ')}`));
                }

                if (detection.config.router) {
                    console.log(chalk.gray('\n  Router Configuration:'));
                    if (detection.config.router.default) {
                        console.log(chalk.gray(`    Default: ${detection.config.router.default}`));
                    }
                    if (detection.config.router.background) {
                        console.log(chalk.gray(`    Background: ${detection.config.router.background}`));
                    }
                    if (detection.config.router.think) {
                        console.log(chalk.gray(`    Think: ${detection.config.router.think}`));
                    }
                    if (detection.config.router.longContext) {
                        console.log(chalk.gray(`    Long Context: ${detection.config.router.longContext}`));
                    }
                }
            }

            if (detection.error) {
                console.log(chalk.yellow(`\n  Warning: ${detection.error}`));
            }
        } else {
            console.log(chalk.red('  Router executable not found!'));
            console.log(chalk.yellow('\n  To install:'));
            console.log(chalk.cyan('    npm install -g @musistudio/claude-code-router'));
        }
    } else {
        console.log(chalk.gray('✗ Disabled'));
        console.log(chalk.gray('  Using default Claude Code'));

        console.log(chalk.yellow('\n  To enable router:'));
        console.log(chalk.cyan('    vibe router enable'));
    }
}

async function showRouterConfig(args: string[]): Promise<void> {
    const settings = await readSettings();
    const configPath = settings.router?.configPath || getDefaultRouterConfigPath();

    console.log(chalk.bold('Router Configuration:\n'));
    console.log(chalk.gray(`Config file: ${configPath}`));

    const detection = await detectRouter(configPath);

    if (detection.config) {
        console.log(chalk.gray('\nConfiguration:'));
        console.log(JSON.stringify(detection.config, null, 2));
    } else {
        console.log(chalk.yellow('\nNo configuration found'));
        console.log(chalk.gray('Run "ccr model" to configure'));
    }
}

function showRouterHelp(): void {
    console.log(`
${chalk.bold('vibe router')} - Claude Code Router management

${chalk.bold('Usage:')}
  vibe router enable [--config-path <path>]    Enable Claude Code Router
  vibe router disable                          Disable router (use default Claude)
  vibe router status                           Show router status and configuration
  vibe router config                           Show detailed router configuration

${chalk.bold('Examples:')}
  vibe router enable                           Enable router with default config
  vibe router enable --config-path ~/my.json   Enable with custom config path
  vibe router disable                          Disable and use default Claude
  vibe router status                           Check current status

${chalk.bold('About Claude Code Router:')}
  Claude Code Router is a middleware that allows you to route Claude Code
  requests to different AI providers (OpenRouter, DeepSeek, Gemini, etc.)
  and switch between models dynamically.

  To install: ${chalk.cyan('npm install -g @musistudio/claude-code-router')}
  To configure: ${chalk.cyan('ccr model')}

${chalk.bold('Note:')}
  When enabled, all Claude sessions will use the router configuration.
  You can switch models in-session using the /model command.
`);
}
