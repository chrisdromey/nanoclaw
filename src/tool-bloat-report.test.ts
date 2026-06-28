import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import crypto from 'crypto';

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type ToolUse = {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
};

type ToolResultBlock =
  | string
  | Array<{ type?: string; text?: string }>
  | Array<unknown>;

type ToolResult = {
  tool_use_id?: string;
  type: 'tool_result';
  content?: ToolResultBlock;
  is_error?: boolean;
};

type JsonlLine = Record<string, unknown>;

type Sample = {
  timestamp?: string;
  sessionId: string;
  requestId?: string;
  tool: {
    name: string;
    id: string;
    input: unknown;
    inputBytes: number;
    inputHash: string;
  };
  result: {
    isError?: boolean;
    inlineBytes: number;
    fileBytes?: number;
    filePath?: string;
    preview: string;
  };
  usage: Required<Usage>;
};

type TimelineRow = {
  timestamp: string;
  sessionId: string;
  requestId: string;
  toolName: string;
  toolUseId: string;
  inputBytes: number;
  inputHash: string;
  outputInlineBytes: number;
  outputFileBytes: number;
  outputFilePath: string;
  outputIsError: boolean;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_cache_read_input_tokens: number;
  usage_cache_creation_input_tokens: number;
};

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function safeStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return '[unstringifiable]';
  }
}

function coerceUsage(u: unknown): Required<Usage> {
  const usage = (u && typeof u === 'object' ? (u as Usage) : {}) as Usage;
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function readJsonlLines(filePath: string): JsonlLine[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JsonlLine);
}

function getStringByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function summarizeToolResultContent(content: ToolResultBlock | undefined): {
  inlineBytes: number;
  preview: string;
  savedFileHint?: string;
} {
  if (content === undefined) return { inlineBytes: 0, preview: '' };

  if (typeof content === 'string') {
    const inlineBytes = getStringByteLength(content);
    const preview = content.slice(0, 500);
    const m = content.match(/Output has been saved to (\/[^\s]+)\./);
    return { inlineBytes, preview, savedFileHint: m?.[1] };
  }

  // Most MCP results are shaped like [{ type: 'text', text: '...' }]
  const asString = safeStringify(content);
  const inlineBytes = getStringByteLength(asString);
  const preview = asString.slice(0, 500);
  let savedFileHint: string | undefined;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object') {
        const text = (item as { text?: string }).text;
        if (typeof text === 'string') {
          const m = text.match(/Output has been saved to (\/[^\s]+)\./);
          if (m?.[1]) savedFileHint = m[1];
        }
      }
    }
  }
  return { inlineBytes, preview, savedFileHint };
}

function isTodayUtcIso(ts: string | undefined): boolean {
  if (!ts) return false;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getUTCFullYear() === 2026 && d.getUTCMonth() === 3 && d.getUTCDate() === 3
  );
}

function resolveSavedToolResultPath(
  groupProjectDir: string,
  sessionId: string,
  savedFileHint: string,
): string | null {
  // In logs, Claude references paths like:
  // /home/node/.claude/projects/-workspace-group/<sessionId>/tool-results/<file>
  // On the host, those live at:
  // /opt/nanoclaw/data/sessions/telegram_main/.claude/projects/-workspace-group/<sessionId>/tool-results/<file>
  const marker = `/projects/-workspace-group/${sessionId}/tool-results/`;
  const idx = savedFileHint.indexOf(marker);
  if (idx === -1) return null;
  const suffix = savedFileHint.slice(idx + marker.length);
  const hostPath = path.join(
    groupProjectDir,
    sessionId,
    'tool-results',
    suffix,
  );
  return fs.existsSync(hostPath) ? hostPath : null;
}

function getToolUseBlocks(messageContent: unknown): ToolUse[] {
  if (!Array.isArray(messageContent)) return [];
  return messageContent.filter(
    (c): c is ToolUse =>
      !!c &&
      typeof c === 'object' &&
      (c as { type?: unknown }).type === 'tool_use' &&
      typeof (c as { id?: unknown }).id === 'string' &&
      typeof (c as { name?: unknown }).name === 'string',
  );
}

function getToolResultBlocks(messageContent: unknown): ToolResult[] {
  if (!Array.isArray(messageContent)) return [];
  return messageContent.filter(
    (c): c is ToolResult =>
      !!c &&
      typeof c === 'object' &&
      (c as { type?: unknown }).type === 'tool_result' &&
      typeof (c as { tool_use_id?: unknown }).tool_use_id === 'string',
  );
}

describe('tool call bloat report (replay from logs)', () => {
  test('collect 5 samples per tool from today and write report', () => {
    const groupProjectDir =
      '/opt/nanoclaw/data/sessions/telegram_main/.claude/projects/-workspace-group';
    expect(fs.existsSync(groupProjectDir)).toBe(true);

    const jsonlPaths = fs
      .readdirSync(groupProjectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(groupProjectDir, f));

    const samplesByTool = new Map<string, Sample[]>();

    for (const jsonlPath of jsonlPaths) {
      const sessionId = path.basename(jsonlPath).replace(/\.jsonl$/, '');
      const lines = readJsonlLines(jsonlPath);

      // Index tool_result blocks by tool_use_id
      const toolResults = new Map<
        string,
        { result: ToolResult; timestamp?: string }
      >();
      for (const line of lines) {
        const ts =
          typeof line.timestamp === 'string'
            ? (line.timestamp as string)
            : undefined;
        if (!isTodayUtcIso(ts)) continue;
        const msg = line.message as { content?: unknown } | undefined;
        const results = getToolResultBlocks(msg?.content);
        for (const r of results) {
          toolResults.set(r.tool_use_id!, { result: r, timestamp: ts });
        }
      }

      for (const line of lines) {
        const ts =
          typeof line.timestamp === 'string'
            ? (line.timestamp as string)
            : undefined;
        if (!isTodayUtcIso(ts)) continue;

        const msg = line.message as
          | { content?: unknown; usage?: unknown }
          | undefined;
        const usage = coerceUsage(msg?.usage);
        const requestId =
          typeof line.requestId === 'string'
            ? (line.requestId as string)
            : undefined;

        const toolUses = getToolUseBlocks(msg?.content);
        for (const tu of toolUses) {
          const toolName = tu.name;

          const existing = samplesByTool.get(toolName) ?? [];
          if (existing.length >= 5) continue;

          const inputStr = safeStringify(tu.input ?? null);
          const inputBytes = getStringByteLength(inputStr);
          const inputHash = sha256(inputStr);

          const tr = toolResults.get(tu.id);
          const { inlineBytes, preview, savedFileHint } =
            summarizeToolResultContent(tr?.result.content);

          let fileBytes: number | undefined;
          let filePath: string | undefined;
          if (savedFileHint) {
            const resolved = resolveSavedToolResultPath(
              groupProjectDir,
              sessionId,
              savedFileHint,
            );
            if (resolved) {
              filePath = resolved;
              fileBytes = fs.statSync(resolved).size;
            }
          }

          const sample: Sample = {
            timestamp: ts,
            sessionId,
            requestId,
            tool: {
              name: toolName,
              id: tu.id,
              input: tu.input ?? null,
              inputBytes,
              inputHash,
            },
            result: {
              isError: tr?.result.is_error,
              inlineBytes,
              fileBytes,
              filePath,
              preview,
            },
            usage,
          };

          existing.push(sample);
          samplesByTool.set(toolName, existing);
        }
      }
    }

    const tools = Array.from(samplesByTool.keys()).sort();
    const report = {
      generatedAt: new Date().toISOString(),
      dayUtc: '2026-04-03',
      toolCount: tools.length,
      tools: tools.map((name) => ({
        name,
        samples: (samplesByTool.get(name) ?? []).map((s) => ({
          timestamp: s.timestamp,
          sessionId: s.sessionId,
          requestId: s.requestId,
          tool: {
            id: s.tool.id,
            inputBytes: s.tool.inputBytes,
            inputHash: s.tool.inputHash,
            input: s.tool.input,
          },
          result: {
            isError: s.result.isError,
            inlineBytes: s.result.inlineBytes,
            fileBytes: s.result.fileBytes,
            filePath: s.result.filePath,
            preview: s.result.preview,
          },
          usage: s.usage,
        })),
      })),
    };

    const outDir = '/opt/nanoclaw/temp/tool-bloat';
    fs.mkdirSync(outDir, { recursive: true });
    const reportPath = path.join(outDir, 'tool-bloat-report.2026-04-03.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    // Also write a chronological timeline CSV across all samples captured (limited to 5 per tool).
    const timelineRows: TimelineRow[] = [];
    for (const t of report.tools) {
      for (const s of t.samples) {
        timelineRows.push({
          timestamp: s.timestamp ?? '',
          sessionId: s.sessionId ?? '',
          requestId: s.requestId ?? '',
          toolName: t.name,
          toolUseId: s.tool.id,
          inputBytes: s.tool.inputBytes,
          inputHash: s.tool.inputHash,
          outputInlineBytes: s.result.inlineBytes,
          outputFileBytes: s.result.fileBytes ?? 0,
          outputFilePath: s.result.filePath ?? '',
          outputIsError: s.result.isError ?? false,
          usage_input_tokens: s.usage.input_tokens,
          usage_output_tokens: s.usage.output_tokens,
          usage_cache_read_input_tokens: s.usage.cache_read_input_tokens,
          usage_cache_creation_input_tokens:
            s.usage.cache_creation_input_tokens,
        });
      }
    }
    timelineRows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const csvHeader = [
      'timestamp',
      'sessionId',
      'requestId',
      'toolName',
      'toolUseId',
      'inputBytes',
      'inputHash',
      'outputInlineBytes',
      'outputFileBytes',
      'outputFilePath',
      'outputIsError',
      'usage_input_tokens',
      'usage_output_tokens',
      'usage_cache_read_input_tokens',
      'usage_cache_creation_input_tokens',
    ];

    const escapeCsv = (v: string | number | boolean) => {
      const s = String(v);
      if (/[\",\n]/.test(s)) return `"${s.replace(/\"/g, '""')}"`;
      return s;
    };

    const csvLines = [
      csvHeader.join(','),
      ...timelineRows.map((r) =>
        csvHeader.map((k) => escapeCsv((r as any)[k])).join(','),
      ),
    ];
    fs.writeFileSync(
      path.join(outDir, 'tool-timeline.samples-only.2026-04-03.csv'),
      csvLines.join('\n') + '\n',
      'utf8',
    );

    // Aggregate summary per tool across captured samples.
    const aggregates = report.tools.map((t) => {
      const rows = t.samples.map((s) => ({
        outBytes: s.result.inlineBytes + (s.result.fileBytes ?? 0),
        inlineBytes: s.result.inlineBytes,
        fileBytes: s.result.fileBytes ?? 0,
        cacheRead: s.usage.cache_read_input_tokens,
        cacheCreate: s.usage.cache_creation_input_tokens,
        outTokens: s.usage.output_tokens,
      }));
      rows.sort((a, b) => a.outBytes - b.outBytes);
      const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
      const median = (arr: number[]) => {
        if (arr.length === 0) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
      };
      const outBytesArr = rows.map((r) => r.outBytes);
      const cacheReadArr = rows.map((r) => r.cacheRead);
      const cacheCreateArr = rows.map((r) => r.cacheCreate);
      const outTokensArr = rows.map((r) => r.outTokens);
      return {
        tool: t.name,
        sampleCount: rows.length,
        outBytesMax: Math.max(...outBytesArr, 0),
        outBytesMedian: median(outBytesArr),
        outBytesTotal: sum(outBytesArr),
        cacheReadMax: Math.max(...cacheReadArr, 0),
        cacheReadMedian: median(cacheReadArr),
        cacheCreateMax: Math.max(...cacheCreateArr, 0),
        cacheCreateMedian: median(cacheCreateArr),
        outputTokensMax: Math.max(...outTokensArr, 0),
        outputTokensMedian: median(outTokensArr),
      };
    });
    aggregates.sort((a, b) => b.outBytesMax - a.outBytesMax);
    fs.writeFileSync(
      path.join(outDir, 'tool-aggregates.samples-only.2026-04-03.json'),
      JSON.stringify(
        { generatedAt: report.generatedAt, dayUtc: report.dayUtc, aggregates },
        null,
        2,
      ),
      'utf8',
    );

    // Minimal assertion: we should find at least some tools today.
    expect(report.toolCount).toBeGreaterThan(0);
  });
});
