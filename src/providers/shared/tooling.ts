import { asRecord, firstString } from '../../core/object.js';
import { sha256Hex } from '../../events/event-id.js';
import type { CanonicalEventType, ContentEvidence } from '../../events/types/events.types.js';
import type { McpToolName, ToolKind } from '../types/provider.types.js';
import {
  COMMAND_KEYS,
  FILE_EDIT_TOOLS,
  FILE_PATH_KEYS,
  FILE_READ_TOOLS,
  MCP_TOOL_PREFIX,
  MCP_TOOL_SEPARATOR,
  SHELL_TOOLS
} from './constants/tooling.constants.js';

export type { McpToolName, ToolKind } from '../types/provider.types.js';

/**
 * What kind of thing a tool call is, whatever the agent calls it.
 *
 * The classification is what decides which canonical event type the call maps
 * to, so "reading a file" is one product signal across every provider.
 *
 * @param toolName - Provider-reported tool name.
 * @returns The kind, defaulting to 'other' for anything unrecognized.
 */
export function classifyTool(toolName: string | undefined): ToolKind {
  if (!toolName) return 'other';

  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcp';

  if (SHELL_TOOLS.has(toolName)) return 'shell';

  if (FILE_READ_TOOLS.has(toolName)) return 'file-read';

  if (FILE_EDIT_TOOLS.has(toolName)) return 'file-edit';

  return 'other';
}

/**
 * Canonical event type for a tool call starting.
 *
 * @param kind - Tool classification.
 * @returns The event type.
 */
export function toolStartType(kind: ToolKind): CanonicalEventType {
  if (kind === 'shell') return 'shell.started';

  if (kind === 'mcp') return 'mcp.started';

  return 'tool.started';
}

/**
 * Canonical event type for a tool call finishing successfully.
 *
 * @param kind - Tool classification.
 * @returns The event type.
 */
export function toolCompleteType(kind: ToolKind): CanonicalEventType {
  if (kind === 'shell') return 'shell.completed';

  if (kind === 'mcp') return 'mcp.completed';

  if (kind === 'file-read') return 'file.read';

  if (kind === 'file-edit') return 'file.edited';

  return 'tool.completed';
}

/**
 * Split "mcp__server__tool" into its parts.
 *
 * @param toolName - Provider-reported tool name.
 * @returns The server and tool, or an empty object for a non-MCP name.
 */
export function parseMcpToolName(toolName: string): McpToolName {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return {};

  const parts = toolName.split(MCP_TOOL_SEPARATOR);

  return { server: parts[1], tool: parts.slice(2).join(MCP_TOOL_SEPARATOR) || undefined };
}

/**
 * Length and hash of text, as evidence for content we may not transmit.
 *
 * Lets the backend verify that a record describes the content the developer
 * actually saw, without the content having to leave the machine.
 *
 * @param text - The content.
 * @returns Its evidence.
 */
export function contentEvidence(text: string): ContentEvidence {
  return { length: text.length, sha256: sha256Hex(text) };
}

/**
 * Best-effort file path out of a heterogeneous tool input.
 *
 * @param toolInput - Whatever the provider passed as the call's arguments.
 * @returns The path, or undefined when the input names none.
 */
export function extractFilePath(toolInput: unknown): string | undefined {
  const record = asRecord(toolInput);

  if (!record) return undefined;

  return firstString(record, FILE_PATH_KEYS);
}

/**
 * Best-effort shell command out of a heterogeneous tool input.
 *
 * @param toolInput - Whatever the provider passed as the call's arguments.
 * @returns The command, or undefined when the input names none.
 */
export function extractCommand(toolInput: unknown): string | undefined {
  const record = asRecord(toolInput);

  if (!record) return undefined;

  return firstString(record, COMMAND_KEYS);
}
