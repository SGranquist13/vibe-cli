/**
 * Cross-platform Vibe CLI spawning utility
 * 
 * ## Background
 * 
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with `node`, but we want to hide deprecation warnings and other 
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 * 
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Vibe.
 * 
 * ## The Wrapper Strategy
 * 
 * We created a wrapper script `bin/vibe.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates 
 * Windows-specific wrapper scripts (`vibe.cmd` and `vibe.ps1`) when it sees 
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 * 
 * The wrapper script either directly execs `dist/index.mjs` with the flags we want,
 * or imports it directly if Node.js already has the right flags.
 * 
 * ## Execution Chains
 * 
 * **Unix/Linux/macOS:**
 * 1. User runs `vibe` command
 * 2. Shell directly executes `bin/vibe.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/vibe.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * **Windows:**
 * 1. User runs `vibe` command  
 * 2. NPM wrapper (`vibe.cmd`) calls `node bin/vibe.mjs`
 * 3. `bin/vibe.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * ## The Spawning Problem
 * 
 * When our code needs to spawn Vibe cli as a subprocess (for daemon processes), 
 * we were trying to execute `bin/vibe.mjs` directly. This fails on Windows 
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 * 
 * ## The Solution
 * 
 * Since we know exactly what needs to happen (run `dist/index.mjs` with specific 
 * Node.js flags), we can bypass all the wrapper layers and do it directly:
 * 
 * `spawn('node', ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 * 
 * This works on all platforms and achieves the same result without any of the 
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';

/**
 * Spawn the Vibe CLI with the given arguments in a cross-platform way.
 * 
 * This function bypasses the wrapper script (bin/vibe.mjs) and spawns the 
 * actual CLI entrypoint (dist/index.mjs) directly with Node.js, ensuring
 * compatibility across all platforms including Windows.
 * 
 * @param args - Arguments to pass to the Vibe CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnVibeCLI(args: string[], options: SpawnOptions = {}): ChildProcess {
  const projectRoot = projectPath();
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're actually executing 'node' with the calculated entrypoint path below,
  // bypassing the 'vibe' wrapper that would normally be found in the shell's PATH.
  // However, we log it as 'vibe' here because other engineers are typically looking
  // for when "vibe" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `vibe ${args.join(' ')}`;
  logger.debug(`[SPAWN VIBE CLI] Spawning: ${fullCommand} in ${directory}`);
  
  // Use the same Node.js flags that the wrapper script uses
  const nodeArgs = [
    '--no-warnings',
    '--no-deprecation',
    entrypoint,
    ...args
  ];

  // Sanity check of the entrypoint path exists
  if (!existsSync(entrypoint)) {
    const errorMessage = `Entrypoint ${entrypoint} does not exist`;
    logger.debug(`[SPAWN VIBE CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }
  
  return spawn('node', nodeArgs, options);
}
