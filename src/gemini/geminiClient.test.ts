import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiClient } from './geminiClient';

const FAKE_GEMINI_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('fake-gemini 0.0.1');
  process.exit(0);
}

const promptIndex = args.indexOf('-p');
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';

const logPath = process.env.GEMINI_TEST_LOG;
if (logPath) {
  const entry = {
    args,
    cwd: process.cwd(),
    prompt,
  };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

const payload = prompt ? 'Prompt::' + prompt : 'stub::ready';
console.log(JSON.stringify({ type: 'assistant', message: payload }));
console.log(JSON.stringify({ type: 'done' }));
`;

function createFakeGeminiBinary(dir: string): string {
  const binaryPath = join(dir, 'fake-gemini.cjs');
  writeFileSync(binaryPath, FAKE_GEMINI_SCRIPT, { encoding: 'utf-8' });
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

async function waitForLogEntries(logPath: string, count: number): Promise<Array<{ args: string[]; cwd: string; prompt: string }>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; cwd: string; prompt: string });
      if (lines.length >= count) {
        return lines;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} Gemini log entries`);
}

describe('GeminiClient', () => {
  let tmpDir: string;
  let previousBin: string | undefined;

  beforeEach(() => {
    previousBin = process.env.VIBE_GEMINI_BIN;
    tmpDir = mkdtempSync(join(tmpdir(), 'gemini-client-'));
    process.env.VIBE_GEMINI_BIN = createFakeGeminiBinary(tmpDir);
  });

  afterEach(() => {
    if (previousBin === undefined) {
      delete process.env.VIBE_GEMINI_BIN;
    } else {
      process.env.VIBE_GEMINI_BIN = previousBin;
    }
    delete process.env.GEMINI_TEST_LOG;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('streams JSON output from the spawned Gemini CLI', async () => {
    const client = new GeminiClient();
    const events: any[] = [];
    const donePromise = new Promise<void>((resolve) => {
      client.setHandler((event) => {
        events.push(event);
        if (event.type === 'done') {
          resolve();
        }
      });
    });

    await client.startSession({ prompt: 'say hello from test', cwd: process.cwd() });
    await donePromise;

    const assistantEvent = events.find((event) => event.type === 'assistant');
    expect(assistantEvent).toBeDefined();
    expect(assistantEvent?.message).toContain('say hello from test');
    expect(events.at(-1)?.type).toBe('done');

    await client.disconnect();
  });

  it('reuses cwd and model when continuing a session', async () => {
    const client = new GeminiClient();
    const logPath = join(tmpDir, 'gemini-invocations.log');
    process.env.GEMINI_TEST_LOG = logPath;

    const customCwd = join(tmpDir, 'project');
    mkdirSync(customCwd);

    client.setHandler(() => {
      // No-op for this test
    });

    await client.startSession({ prompt: 'initial prompt', cwd: customCwd, model: 'gemini-pro' });
    await waitForLogEntries(logPath, 1);

    await client.continueSession('follow-up prompt');
    const entries = await waitForLogEntries(logPath, 2);

    expect(entries).toHaveLength(2);
    expect(entries[0].cwd).toBe(customCwd);
    expect(entries[1].cwd).toBe(customCwd);
    expect(entries[0].prompt).toBe('initial prompt');
    expect(entries[1].prompt).toBe('follow-up prompt');

    for (const entry of entries) {
      expect(entry.args).toContain('-m');
      expect(entry.args).toContain('gemini-pro');
      expect(entry.args).toContain('--output-format');
      expect(entry.args).toContain('stream-json');
    }

    await client.disconnect();
  });
});
