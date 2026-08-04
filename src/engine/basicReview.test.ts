import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectOllama, ollamaNumCtx, runBasicReview } from './basicReview.js';

const run = promisify(execFile);
const git = (repo: string, args: string[]) => run('git', ['-C', repo, ...args]);

/** Scratch repo with one modified tracked file, reviewed as working-tree changes. */
let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'margin-test-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@test']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'util.js'), 'function add(a, b) {\n  return a + b;\n}\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  await writeFile(join(repo, 'util.js'), 'function add(a, b) {\n  return a - b;\n}\n');
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

const target = () => ({ repoPath: repo, baseRef: 'HEAD', headRef: null });

const REVIEW_JSON = JSON.stringify({
  changeSummary: 'Subtraction instead of addition.',
  findings: [
    {
      file: 'util.js',
      line: 2,
      severity: 'high',
      category: 'correctness',
      summary: 'add() subtracts',
      failureScenario: 'add(1, 2) returns -1 instead of 3',
      snippet: 'return a - b;',
    },
  ],
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

const listen = (server: Server) =>
  new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    resolve(`http://127.0.0.1:${addr.port}`);
  }));

/** Fake Ollama: answers /api/version, records the /api/chat request body. */
async function fakeOllama(): Promise<{ origin: string; requests: Array<Record<string, unknown>>; close: () => void }> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/api/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: '0.31.2' }));
      return;
    }
    if (req.url === '/api/chat') {
      requests.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: { role: 'assistant', content: REVIEW_JSON } }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const origin = await listen(server);
  return { origin, requests, close: () => server.close() };
}

/** Fake plain OpenAI-compatible server: no /api/version, serves /v1/chat/completions. */
async function fakeOpenAi(): Promise<{ origin: string; requests: Array<Record<string, unknown>>; close: () => void }> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/chat/completions') {
      requests.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: REVIEW_JSON } }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const origin = await listen(server);
  return { origin, requests, close: () => server.close() };
}

describe('ollamaNumCtx', () => {
  it('sizes the context to the prompt plus output headroom', () => {
    // 160k chars ≈ 50k tokens at 3.2 chars/token, plus 8k headroom.
    expect(ollamaNumCtx(160_000)).toBe(58_192);
  });

  it('clamps small prompts up to the floor', () => {
    expect(ollamaNumCtx(1_000)).toBe(16_384);
  });

  it('clamps huge prompts to the cap', () => {
    expect(ollamaNumCtx(10_000_000)).toBe(65_536);
  });
});

describe('detectOllama', () => {
  it('recognizes an Ollama server behind an OpenAI-style baseUrl', async () => {
    const ollama = await fakeOllama();
    try {
      expect(await detectOllama(`${ollama.origin}/v1`)).toBe(ollama.origin);
    } finally {
      ollama.close();
    }
  });

  it('returns null for plain OpenAI-compatible servers', async () => {
    const openai = await fakeOpenAi();
    try {
      expect(await detectOllama(`${openai.origin}/v1`)).toBeNull();
    } finally {
      openai.close();
    }
  });

  it('returns null when the endpoint is unreachable', async () => {
    expect(await detectOllama('http://127.0.0.1:1/v1')).toBeNull();
  });
});

describe('runBasicReview endpoint dispatch', () => {
  it('speaks the native chat API with an explicit num_ctx to Ollama', async () => {
    const ollama = await fakeOllama();
    try {
      const result = await runBasicReview(target(), {
        baseUrl: `${ollama.origin}/v1`,
        apiKey: '',
        model: 'Qwen3-Coder',
      });
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({ file: 'util.js', line: 2, source: 'Qwen3-Coder' });
      expect(ollama.requests).toHaveLength(1);
      const req = ollama.requests[0];
      expect(req.stream).toBe(false);
      expect(req.format).toBe('json');
      expect((req.options as { num_ctx: number }).num_ctx).toBeGreaterThanOrEqual(16_384);
    } finally {
      ollama.close();
    }
  });

  it('keeps the OpenAI-compatible path for non-Ollama endpoints', async () => {
    const openai = await fakeOpenAi();
    try {
      const result = await runBasicReview(target(), {
        baseUrl: `${openai.origin}/v1`,
        apiKey: 'sk-test',
        model: 'gpt-5',
      });
      expect(result.findings).toHaveLength(1);
      expect(openai.requests).toHaveLength(1);
      expect(openai.requests[0].response_format).toEqual({ type: 'json_object' });
      expect(openai.requests[0]).not.toHaveProperty('options');
    } finally {
      openai.close();
    }
  });
});
