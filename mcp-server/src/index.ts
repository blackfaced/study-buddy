#!/usr/bin/env node
// src/index.ts
// Study Buddy MCP Server - 陪孩子写作业
//
// 工具实现全部在 ./tools.ts（这样 vitest 可以单独 import handleTool
// 而不会触发这里的 stdio transport）。本文件只做 MCP server 启动。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { handleTool, TOOLS } from "./tools.js";

const server = new Server(
  { name: "study-buddy", version: "0.5b" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const result = await handleTool(params.name, params.arguments || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[study-buddy] MCP server running on stdio");
