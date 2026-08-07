import { sha256Hex } from '../../events/event-id.js';
import type { CanonicalEventType } from '../../events/canonical-event.js';

export type ToolKind = 'shell' | 'mcp' | 'file-read' | 'file-edit' | 'other';

const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command']);
const FILE_READ_TOOLS = new Set(['Read', 'read_file', 'view_image']);
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

export function classifyTool(toolName: string | undefined): ToolKind {
  if (!toolName) return 'other';
  if (toolName.startsWith('mcp__')) return 'mcp';
  if (SHELL_TOOLS.has(toolName)) return 'shell';
  if (FILE_READ_TOOLS.has(toolName)) return 'file-read';
  if (FILE_EDIT_TOOLS.has(toolName)) return 'file-edit';
  return 'other';
}

export function toolStartType(kind: ToolKind): CanonicalEventType {
  switch (kind) {
    case 'shell':
      return 'shell.started';
    case 'mcp':
      return 'mcp.started';
    default:
      return 'tool.started';
  }
}

export function toolCompleteType(kind: ToolKind): CanonicalEventType {
  switch (kind) {
    case 'shell':
      return 'shell.completed';
    case 'mcp':
      return 'mcp.completed';
    case 'file-read':
      return 'file.read';
    case 'file-edit':
      return 'file.edited';
    default:
      return 'tool.completed';
  }
}

/** "mcp__server__tool" -> { server, tool } */
export function parseMcpToolName(toolName: string): { server?: string; tool?: string } {
  if (!toolName.startsWith('mcp__')) return {};
  const parts = toolName.split('__');
  return { server: parts[1], tool: parts.slice(2).join('__') || undefined };
}

/** Length + hash evidence for text we do not capture verbatim. */
export function contentEvidence(text: string): { length: number; sha256: string } {
  return { length: text.length, sha256: sha256Hex(text) };
}

/** Best-effort file path from heterogeneous tool inputs. */
export function extractFilePath(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined;
  const record = toolInput as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
