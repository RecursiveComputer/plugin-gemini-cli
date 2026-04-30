/**
 * Gemini CLI adapter — runs the `gemini` CLI.
 * Uses headless mode (-p) with streaming JSON output.
 * Uses the unified config resolver for rules, skills, subagents, and MCP.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = process.env.RECURSIVE_WORKSPACE || path.resolve(__dirname, '..', '..', '..');
const { resolveForAdapter, syncToWorkspace, buildStablePreamble, buildDynamicContext } = require(path.join(WORKSPACE, 'apps/recursive/config/resolver'));

function resolveImagePaths(imagePaths) {
  if (!imagePaths?.length) return [];
  const recursiveHome = process.env.RECURSIVE_HOME || path.join(os.homedir(), '.recursive');
  return imagePaths
    .map(p => path.isAbsolute(p) ? p : path.join(recursiveHome, p))
    .filter(p => fs.existsSync(p));
}

const type = 'gemini';
const label = 'Gemini CLI';
const syncable = true;

function execute(agent, context) {
  const { workspace, prompt, model, phase, sessionId, images, onStdout, onStderr, onClose, onError } = context;
  const adapterConfig = parseConfig(agent.adapter_config);

  try {
    const configs = resolveForAdapter('gemini', { phase, workspace });
    syncToWorkspace('gemini', workspace, configs);
  } catch (_) {}

  const promptAlreadyHasPreamble = prompt && (prompt.includes('## Canonical Rules') || prompt.includes('## Agent Rules'));
  let preamble = null;
  if (!promptAlreadyHasPreamble) {
    try {
      const stablePart = buildStablePreamble('gemini', { firstMessage: !sessionId, workspace });
      const dynamicPart = buildDynamicContext(agent, {
        runId: context.sessionId ?? context.runId,
        projectPath: workspace,
        step: phase,
      });
      preamble = stablePart + '\n\n' + dynamicPart;
    } catch (_) {}
  }

  let imagesSuffix = '';
  if (images?.length) {
    const resolvedPaths = resolveImagePaths(images);
    if (resolvedPaths.length) {
      imagesSuffix = '\n\n---\n\nThe user attached the following image(s). Use your Read tool to view them:\n' +
        resolvedPaths.map(p => `- ${p}`).join('\n');
    }
  }

  const fullPrompt = (preamble ? `${preamble}\n\n---\n\n${prompt}` : prompt) + imagesSuffix;

  const args = ['--output-format', 'stream-json', '--approval-mode', 'yolo'];
  const effectiveModel = adapterConfig.model || model;
  if (effectiveModel && effectiveModel !== 'auto') args.push('--model', effectiveModel);
  if (sessionId) args.push('--resume', sessionId);

  args.push('--prompt', 'Executing agent request...');

  const env = { ...process.env };
  if (!adapterConfig.env?.GEMINI_API_KEY) delete env.GEMINI_API_KEY;
  if (!adapterConfig.env?.GOOGLE_API_KEY) delete env.GOOGLE_API_KEY;
  if (adapterConfig.env) Object.assign(env, adapterConfig.env);
  if (agent?.id) env.RECURSIVE_SESSION_ID = agent.id;

  const proc = spawn('gemini', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workspace,
    env,
    detached: true,
  });

  if (proc.stdin) {
    proc.stdin.on('error', () => {});
    try {
      proc.stdin.write(fullPrompt);
      proc.stdin.end();
    } catch (_) {
      try { proc.stdin.end(); } catch (__) {}
    }
  }

  if (onStdout) proc.stdout.on('data', onStdout);
  if (onStderr) proc.stderr.on('data', onStderr);
  if (onClose) proc.on('close', onClose);
  if (onError) proc.on('error', onError);

  return { pid: proc.pid, process: proc };
}

function cancel(proc) {
  if (!proc?.pid) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {
    try { proc.kill('SIGTERM'); } catch (__) {}
  }
  const timer = setTimeout(() => {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {
      try { proc.kill('SIGKILL'); } catch (__) {}
    }
  }, 5000);
  timer.unref();
}

function parseConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

const MODEL_ALIASES = [
  { id: 'auto', name: 'Auto', description: 'Default model selection (Gemini Pro)' },
  { id: 'pro', name: 'Pro', description: 'Complex reasoning tasks (Gemini 2.5 Pro / 3 Pro)' },
  { id: 'flash', name: 'Flash', description: 'Fast, balanced model (Gemini 2.5 Flash)' },
  { id: 'flash-lite', name: 'Flash Lite', description: 'Fastest model for simple tasks' },
];

const bundledModels = MODEL_ALIASES;

function discoverModels() {
  return new Promise((resolve) => {
    const proc = spawn('gemini', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });

    proc.stdout.on('data', () => {});
    proc.on('close', (code) => resolve(code === 0 ? MODEL_ALIASES : []));
    proc.on('error', () => resolve([]));

    setTimeout(() => {
      try { proc.kill(); } catch (_) {}
    }, 10000);
  });
}

/* ── Usage fetching via /stats session ── */

const USAGE_TIMEOUT_MS = 15000;

function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[=>][^\x1B]*/g, '')
    .replace(/\x1B\[\?[0-9;]*[hl]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Parse Gemini `/stats session` output for per-model usage data.
 *
 * The output is a box-drawn table rendered by Ink TUI:
 *   │  Model                   Reqs    Model usage                 Usage resets          │
 *   │  gemini-2.5-flash           -    ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬    0%  4:35 PM (23h 58m)  │
 *   │  gemini-2.5-pro             -    ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬   13%  4:39 PM (2m)        │
 *
 * PTY cursor movement codes mix with text, so after stripping ANSI we do a flat
 * regex scan for model-name + percentage + optional reset time patterns.
 */
function parseGeminiOutput(raw: string): { label: string; used_pct: number; remaining_pct: number; resets_label?: string }[] {
  const stripped = stripAnsi(raw);
  const clean = stripped.replace(/[\u2500-\u257F\u2580-\u259F\u2550-\u256C]/g, ' ');
  const metrics: { label: string; used_pct: number; remaining_pct: number; resets_label?: string }[] = [];

  const lines = clean.split(/\r?\n/);
  for (const line of lines) {
    const modelMatch = line.match(/(gemini[\w.\-]+)/i);
    if (!modelMatch) continue;

    const afterModel = line.slice(modelMatch.index! + modelMatch[0].length);
    const pctMatch = afterModel.match(/(\d{1,3})%/);
    if (!pctMatch) continue;

    const modelName = modelMatch[1];
    const usedPct = parseInt(pctMatch[1], 10);
    const resetMatch = afterModel.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)\s*\([^)]+\))/i);

    metrics.push({
      label: modelName,
      used_pct: usedPct,
      remaining_pct: 100 - usedPct,
      resets_label: resetMatch ? resetMatch[1].trim() : undefined,
    });
  }

  if (metrics.length > 0) return metrics;

  const pctRegex = /\s(\d{1,3})%\s/g;
  let pctM: RegExpExecArray | null;
  let idx = 0;
  while ((pctM = pctRegex.exec(clean)) !== null) {
    const val = parseInt(pctM[1], 10);
    if (val <= 100) {
      metrics.push({ label: `Model ${idx + 1}`, used_pct: val, remaining_pct: 100 - val });
      idx++;
    }
  }

  return metrics;
}

async function fetchUsage(opts?: { pty?: unknown }): Promise<{
  adapter: string;
  fetched_at: string;
  metrics: { label: string; used_pct: number; remaining_pct: number; resets_at?: string; resets_label?: string }[];
  error?: string;
}> {
  type NodePtyModule = typeof import('node-pty');
  const ptyMod = (opts?.pty ?? null) as NodePtyModule | null;
  if (!ptyMod) {
    return { adapter: type, fetched_at: new Date().toISOString(), metrics: [], error: 'node-pty not available' };
  }

  return new Promise((resolve) => {
    let output = '';
    let resolved = false;
    const done = (result: Parameters<typeof resolve>[0]) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    const ptyProc = ptyMod.spawn('gemini', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 50,
      cwd: WORKSPACE,
      env: { ...process.env } as Record<string, string>,
    });

    const timer = setTimeout(() => {
      try { fs.writeFileSync('/tmp/gemini-usage-pty-timeout.txt', stripAnsi(output)); } catch (_) {}
      try { ptyProc.kill(); } catch (_) {}
      const metrics = parseGeminiOutput(output);
      done({ adapter: type, fetched_at: new Date().toISOString(), metrics, error: metrics.length ? undefined : 'timeout — no parseable usage data' });
    }, USAGE_TIMEOUT_MS);

    let commandSent = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    ptyProc.onData((data: string) => {
      output += data;

      if (!commandSent) {
        const clean = stripAnsi(output);
        if (clean.includes('❯') || clean.includes('>>> ') || clean.includes('Gemini')) {
          commandSent = true;
          setTimeout(() => {
            output = '';
            ptyProc.write('/stats session\r');
          }, 500);
        }
        return;
      }

      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { fs.writeFileSync('/tmp/gemini-usage-pty-clean.txt', stripAnsi(output)); } catch (_) {}
        try { ptyProc.write('/quit\r'); } catch (_) {}
        setTimeout(() => {
          try { ptyProc.kill(); } catch (_) {}
          const metrics = parseGeminiOutput(output);
          done({
            adapter: type,
            fetched_at: new Date().toISOString(),
            metrics,
            error: metrics.length ? undefined : 'no parseable usage data from /stats session',
          });
        }, 500);
      }, 2500);
    });

    ptyProc.onExit(() => {
      const metrics = parseGeminiOutput(output);
      done({
        adapter: type,
        fetched_at: new Date().toISOString(),
        metrics,
        error: metrics.length ? undefined : 'process exited before usage data received',
      });
    });
  });
}

export { type, label, syncable, execute, cancel, discoverModels, fetchUsage, bundledModels };
