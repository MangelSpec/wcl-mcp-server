import type { CallToolResult } from "@modelcontextprotocol/server";

export function ok(data: unknown): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  if (text === undefined) throw new Error("Tool result is not JSON-serializable");
  return {
    content: [{ type: "text", text }],
    structuredContent: data,
  };
}

export function err(
  message: string,
  details?: Record<string, unknown>,
): CallToolResult {
  const structuredContent = { error: message, ...details };
  return {
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
  };
}
