import type { CallToolResult } from "@modelcontextprotocol/server";
import { getEvidenceResultMeta } from "./evidenceCache.js";

export function ok(data: unknown): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  if (text === undefined)
    throw new Error("Tool result is not JSON-serializable");
  const result: CallToolResult = {
    content: [{ type: "text", text }],
    structuredContent: data,
  };
  return attachEvidenceMeta(result);
}

export function err(
  message: string,
  details?: Record<string, unknown>,
): CallToolResult {
  const structuredContent = { error: message, ...details };
  return attachEvidenceMeta({
    content: [
      {
        type: "text",
        text: details
          ? JSON.stringify(structuredContent, null, 2)
          : `Error: ${message}`,
      },
    ],
    isError: true,
    structuredContent,
  });
}

function attachEvidenceMeta(result: CallToolResult): CallToolResult {
  const meta = getEvidenceResultMeta();
  if (meta) result._meta = meta;
  return result;
}
