/**
 * Main query implementation for Claude Code SDK
 * Handles spawning Claude process and managing message streams
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { Stream } from './stream'
import {
    type QueryOptions,
    type QueryPrompt,
    type SDKMessage,
    type ControlResponseHandler,
    type SDKControlRequest,
    type ControlRequest,
    type SDKControlResponse,
    type CanCallToolCallback,
    type CanUseToolControlRequest,
    type CanUseToolControlResponse,
    type ControlCancelRequest,
    type PermissionResult,
    AbortError
} from './types'
import { getDefaultClaudeCodePath, logDebug, streamToStdin } from './utils'
import type { Writable } from 'node:stream'
import { logger } from '@/ui/logger'

/**
 * Query class manages Claude Code process interaction
 */
export class Query implements AsyncIterableIterator<SDKMessage> {
    private pendingControlResponses = new Map<string, ControlResponseHandler>()
    private cancelControllers = new Map<string, AbortController>()
    private sdkMessages: AsyncIterableIterator<SDKMessage>
    private inputStream = new Stream<SDKMessage>()
    private canCallTool?: CanCallToolCallback

    constructor(
        private childStdin: Writable | null,
        private childStdout: NodeJS.ReadableStream,
        private processExitPromise: Promise<void>,
        canCallTool?: CanCallToolCallback
    ) {
        this.canCallTool = canCallTool
        this.readMessages()
        this.sdkMessages = this.readSdkMessages()
    }

    /**
     * Set an error on the stream
     */
    setError(error: Error): void {
        logger.debug(`[Query] Setting error on stream: ${error.message}, type: ${error.constructor.name}`);
        logger.debug(`[Query] Error stack: ${error.stack}`);
        this.inputStream.error(error)
    }

    /**
     * AsyncIterableIterator implementation
     */
    next(...args: [] | [undefined]): Promise<IteratorResult<SDKMessage>> {
        return this.sdkMessages.next(...args)
    }

    return(value?: any): Promise<IteratorResult<SDKMessage>> {
        if (this.sdkMessages.return) {
            return this.sdkMessages.return(value)
        }
        return Promise.resolve({ done: true, value: undefined })
    }

    throw(e: any): Promise<IteratorResult<SDKMessage>> {
        if (this.sdkMessages.throw) {
            return this.sdkMessages.throw(e)
        }
        return Promise.reject(e)
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
        return this.sdkMessages
    }

    /**
     * Read messages from Claude process stdout
     */
    private async readMessages(): Promise<void> {
        logger.debug(`[Query] Starting to read messages from stdout`);
        const rl = createInterface({ input: this.childStdout })

        try {
            let lineCount = 0;
            for await (const line of rl) {
                lineCount++;
                if (lineCount <= 10) { // Log first 10 lines
                    logger.debug(`[Query] Received line ${lineCount}: ${line.substring(0, 200)}`);
                }
                if (line.trim()) {
                    try {
                        const message = JSON.parse(line) as SDKMessage | SDKControlResponse
                        logger.debug(`[Query] Parsed message type: ${message.type}`);

                        if (message.type === 'control_response') {
                            const controlResponse = message as SDKControlResponse
                            const handler = this.pendingControlResponses.get(controlResponse.response.request_id)
                            if (handler) {
                                handler(controlResponse.response)
                            }
                            continue
                        } else if (message.type === 'control_request') {
                            await this.handleControlRequest(message as unknown as CanUseToolControlRequest)
                            continue
                        } else if (message.type === 'control_cancel_request') {
                            this.handleControlCancelRequest(message as unknown as ControlCancelRequest)
                            continue
                        }

                        this.inputStream.enqueue(message)
                    } catch (e) {
                        logger.debug(`[Query] Failed to parse line: ${line.substring(0, 200)}, error: ${e}`);
                    }
                }
            }
            logger.debug(`[Query] Finished reading messages, total lines: ${lineCount}`);
            await this.processExitPromise
        } catch (error) {
            logger.debug(`[Query] Error reading messages: ${error}`);
            this.inputStream.error(error as Error)
        } finally {
            this.inputStream.done()
            this.cleanupControllers()
            rl.close()
        }
    }

    /**
     * Async generator for SDK messages
     */
    private async *readSdkMessages(): AsyncIterableIterator<SDKMessage> {
        for await (const message of this.inputStream) {
            yield message
        }
    }

    /**
     * Send interrupt request to Claude
     */
    async interrupt(): Promise<void> {
        if (!this.childStdin) {
            throw new Error('Interrupt requires --input-format stream-json')
        }

        await this.request({
            subtype: 'interrupt'
        }, this.childStdin)
    }

    /**
     * Send control request to Claude process
     */
    private request(request: ControlRequest, childStdin: Writable): Promise<SDKControlResponse['response']> {
        const requestId = Math.random().toString(36).substring(2, 15)
        const sdkRequest: SDKControlRequest = {
            request_id: requestId,
            type: 'control_request',
            request
        }

        return new Promise((resolve, reject) => {
            this.pendingControlResponses.set(requestId, (response) => {
                if (response.subtype === 'success') {
                    resolve(response)
                } else {
                    reject(new Error(response.error))
                }
            })

            childStdin.write(JSON.stringify(sdkRequest) + '\n')
        })
    }

    /**
     * Handle incoming control requests for tool permissions
     * Replicates the exact logic from the SDK's handleControlRequest method
     */
    private async handleControlRequest(request: CanUseToolControlRequest): Promise<void> {
        if (!this.childStdin) {
            logDebug('Cannot handle control request - no stdin available')
            return
        }

        const controller = new AbortController()
        this.cancelControllers.set(request.request_id, controller)

        try {
            const response = await this.processControlRequest(request, controller.signal)
            const controlResponse: CanUseToolControlResponse = {
                type: 'control_response',
                response: {
                    subtype: 'success',
                    request_id: request.request_id,
                    response
                }
            }
            this.childStdin.write(JSON.stringify(controlResponse) + '\n')
        } catch (error) {
            const controlErrorResponse: CanUseToolControlResponse = {
                type: 'control_response',
                response: {
                    subtype: 'error',
                    request_id: request.request_id,
                    error: error instanceof Error ? error.message : String(error)
                }
            }
            this.childStdin.write(JSON.stringify(controlErrorResponse) + '\n')
        } finally {
            this.cancelControllers.delete(request.request_id)
        }
    }

    /**
     * Handle control cancel requests
     * Replicates the exact logic from the SDK's handleControlCancelRequest method
     */
    private handleControlCancelRequest(request: ControlCancelRequest): void {
        const controller = this.cancelControllers.get(request.request_id)
        if (controller) {
            controller.abort()
            this.cancelControllers.delete(request.request_id)
        }
    }

    /**
     * Process control requests based on subtype
     * Replicates the exact logic from the SDK's processControlRequest method
     */
    private async processControlRequest(request: CanUseToolControlRequest, signal: AbortSignal): Promise<PermissionResult> {
        if (request.request.subtype === 'can_use_tool') {
            if (!this.canCallTool) {
                throw new Error('canCallTool callback is not provided.')
            }
            return this.canCallTool(request.request.tool_name, request.request.input, {
                signal
            })
        }
        
        throw new Error('Unsupported control request subtype: ' + request.request.subtype)
    }

    /**
     * Cleanup method to abort all pending control requests
     */
    private cleanupControllers(): void {
        for (const [requestId, controller] of this.cancelControllers.entries()) {
            controller.abort()
            this.cancelControllers.delete(requestId)
        }
    }
}

/**
 * Main query function to interact with Claude Code
 */
export function query(config: {
    prompt: QueryPrompt
    options?: QueryOptions
}): Query {
    const {
        prompt,
        options: {
            allowedTools = [],
            appendSystemPrompt,
            customSystemPrompt,
            cwd,
            disallowedTools = [],
            executable = 'node',
            executableArgs = [],
            maxTurns,
            mcpServers,
            pathToClaudeCodeExecutable = getDefaultClaudeCodePath(),
            permissionMode = 'default',
            continue: continueConversation,
            resume,
            model,
            fallbackModel,
            strictMcpConfig,
            canCallTool,
            useRouter = false,
            routerConfigPath
        } = {}
    } = config

    // Set entrypoint if not already set
    if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
        process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    }

    // Build command arguments
    const args = ['--output-format', 'stream-json', '--verbose']

    if (customSystemPrompt) args.push('--system-prompt', customSystemPrompt)
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt)
    if (maxTurns) args.push('--max-turns', maxTurns.toString())
    if (model) args.push('--model', model)
    if (canCallTool) {
        if (typeof prompt === 'string') {
            throw new Error('canCallTool callback requires --input-format stream-json. Please set prompt as an AsyncIterable.')
        }
        args.push('--permission-prompt-tool', 'stdio')
    }
    if (continueConversation) args.push('--continue')
    if (resume) args.push('--resume', resume)
    if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','))
    if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','))
    if (mcpServers && Object.keys(mcpServers).length > 0) {
        args.push('--mcp-config', JSON.stringify({ mcpServers }))
    }
    if (strictMcpConfig) args.push('--strict-mcp-config')
    if (permissionMode) args.push('--permission-mode', permissionMode)

    if (fallbackModel) {
        if (model && fallbackModel === model) {
            throw new Error('Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.')
        }
        args.push('--fallback-model', fallbackModel)
    }

    // Handle prompt input
    if (typeof prompt === 'string') {
        args.push('--print', prompt.trim())
    } else {
        args.push('--input-format', 'stream-json')
    }

    // Determine final executable and args based on router usage
    let finalExecutable = executable
    let finalArgs: string[] = []

    if (useRouter) {
        // Router mode: validate that caller has provided appropriate executable and executableArgs
        if (!executable || executableArgs.length === 0) {
            throw new Error('Router mode requires explicit executable and executableArgs to be provided. Ensure router detection has been performed and spawn config is set.')
        }
        logger.debug('[query] Using Claude Code Router mode')
        finalExecutable = executable
        finalArgs = [...executableArgs, ...args]
    } else {
        // Normal mode: validate executable path
        if (!existsSync(pathToClaudeCodeExecutable)) {
            throw new ReferenceError(`Claude Code executable not found at ${pathToClaudeCodeExecutable}. Is options.pathToClaudeCodeExecutable set?`)
        }
        finalExecutable = executable
        finalArgs = [...executableArgs, pathToClaudeCodeExecutable, ...args]
    }

    // Spawn Claude Code process
    logDebug(`Spawning Claude Code process: ${finalExecutable} ${finalArgs.join(' ')}`)

    // On Windows, .cmd files need to be run via cmd.exe or with shell: true
    const needsShell = process.platform === 'win32' && 
                       (finalExecutable.toLowerCase().endsWith('.cmd') || 
                        finalExecutable.toLowerCase().endsWith('.bat'))

    // When using shell: true, combine executable and args into a single command string
    let spawnExecutable = finalExecutable;
    let spawnArgs = finalArgs;
    let spawnOptions: any = {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: config.options?.abort,
        env: {
            ...process.env
        }
    };

    if (needsShell) {
        // For .cmd/.bat files on Windows, use shell: true
        // Note: When shell: true, Node.js will properly handle argument escaping
        spawnOptions.shell = true;
        logger.debug(`[query] Using shell mode for Windows .cmd/.bat file`);
    }

    logger.debug(`[query] Spawning with executable: ${spawnExecutable}, args count: ${spawnArgs.length}, shell: ${spawnOptions.shell || false}`);
    logger.debug(`[query] First few args: ${spawnArgs.slice(0, 5).join(' ')}`);
    const child = spawn(spawnExecutable, spawnArgs, spawnOptions) as ChildProcessWithoutNullStreams
    
    // Log process spawn event
    child.on('spawn', () => {
        logger.debug(`[query] Process spawned successfully, PID: ${child.pid}`);
    });

    // Handle stdin
    let childStdin: Writable | null = null
    if (typeof prompt === 'string') {
        child.stdin.end()
    } else {
        streamToStdin(prompt, child.stdin, config.options?.abort)
        childStdin = child.stdin
    }

    // Handle stderr - always capture for debugging
    let stderrOutput = '';
    child.stderr.on('data', (data) => {
        const output = data.toString();
        stderrOutput += output;
        logger.debug(`[query] Claude Code stderr: ${output}`);
        if (process.env.DEBUG) {
            console.error('Claude Code stderr:', output)
        }
    })
    
    // Handle stdout data events for debugging
    let stdoutChunks = 0;
    child.stdout.on('data', (data) => {
        stdoutChunks++;
        if (stdoutChunks <= 5) { // Log first 5 chunks
            logger.debug(`[query] Claude Code stdout chunk ${stdoutChunks}: ${data.toString().substring(0, 200)}`);
        }
    })

    // Setup cleanup
    const cleanup = () => {
        if (!child.killed) {
            child.kill('SIGTERM')
        }
    }

    config.options?.abort?.addEventListener('abort', cleanup)
    process.on('exit', cleanup)

    // Handle process exit
    const processExitPromise = new Promise<void>((resolve) => {
        child.on('close', (code, signal) => {
            logger.debug(`[query] Process closed with code: ${code}, signal: ${signal}`);
            if (stderrOutput) {
                logger.debug(`[query] Process stderr output (full): ${stderrOutput}`);
            }
            if (stdoutChunks === 0) {
                logger.debug(`[query] WARNING: No stdout chunks received before process exit!`);
            }
            if (config.options?.abort?.aborted) {
                query.setError(new AbortError('Claude Code process aborted by user'))
            } else if (code !== 0) {
                const errorMsg = stderrOutput 
                    ? `Claude Code process exited with code ${code}. Stderr: ${stderrOutput.substring(0, 500)}`
                    : `Claude Code process exited with code ${code}`;
                logger.debug(`[query] Process exited with error: ${errorMsg}`);
                query.setError(new Error(errorMsg))
            } else {
                resolve()
            }
        })
        
        child.on('error', (error) => {
            logger.debug(`[query] Process error event: ${error.message}, code: ${error.name}`);
        });
    })

    // Create query instance
    const query = new Query(childStdin, child.stdout, processExitPromise, canCallTool)

    // Handle process errors
    child.on('error', (error) => {
        logger.debug(`[query] Process error handler: ${error.message}, code: ${error.name}`);
        if (config.options?.abort?.aborted) {
            query.setError(new AbortError('Claude Code process aborted by user'))
        } else {
            query.setError(new Error(`Failed to spawn Claude Code process: ${error.message}`))
        }
    })
    
    // Add timeout check - if no output after 10 seconds, log warning
    const timeoutId = setTimeout(() => {
        if (stdoutChunks === 0 && !child.killed) {
            logger.debug(`[query] WARNING: No stdout received after 10 seconds. Process PID: ${child.pid}, killed: ${child.killed}`);
        }
    }, 10000);
    
    // Clear timeout when process exits or stdout starts
    child.on('close', () => clearTimeout(timeoutId));
    child.stdout.once('data', () => {
        clearTimeout(timeoutId);
        logger.debug(`[query] First stdout data received, clearing timeout`);
    });

    // Cleanup on exit
    processExitPromise.finally(() => {
        cleanup()
        config.options?.abort?.removeEventListener('abort', cleanup)
        if (process.env.CLAUDE_SDK_MCP_SERVERS) {
            delete process.env.CLAUDE_SDK_MCP_SERVERS
        }
    })

    return query
}