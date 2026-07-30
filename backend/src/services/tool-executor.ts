import type { ToolCall } from "../types/index.js";
import { executeWebResearch } from "../tools/web-research.js";

export interface ToolResult {
  tool_call_id: string;
  role: "tool";
  content: string;
}

export async function executeToolCall(
  toolCall: ToolCall,
  conversationId: string,
): Promise<ToolResult> {
  const parsedArgs = JSON.parse(toolCall.function.arguments);

  let content: string;

  switch (toolCall.function.name) {
    case "web_research":
      content = await executeWebResearch(
        String(parsedArgs.query ?? ""),
        typeof parsedArgs.max_results === "number"
          ? parsedArgs.max_results
          : undefined,
      );
      break;

    case "search_project_files":
      // STUB — implemented by F5-03
      throw new Error("search_project_files not yet implemented");

    case "read_file":
      // STUB — implemented by F5-03
      throw new Error("read_file not yet implemented");

    case "list_attachments":
      // STUB — implemented by F5-03
      throw new Error("list_attachments not yet implemented");

    default: {
      const _exhaustive: never = toolCall.function.name;
      content = `Unknown tool: ${_exhaustive}`;
    }
  }

  return {
    tool_call_id: toolCall.id,
    role: "tool",
    content,
  };
}
