import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_research",
      description:
        "Search the web for current information using surf-research-skill. Use for facts, news, documentation, or anything not in local files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (max 400 chars)" },
          max_results: { type: "number", description: "Max results (1-10, default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_project_files",
      description:
        "Search for a pattern in files attached to the current conversation using grep.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Grep pattern (supports regex)" },
          path: {
            type: "string",
            description: "Optional: restrict to a specific file or subdirectory",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full content of a file attached to the current conversation.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Name of the attached file" },
        },
        required: ["filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_attachments",
      description: "List all files attached to the current conversation.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];
