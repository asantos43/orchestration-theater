import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Jsonl } from "./log.ts";

export type McpHandle = { url: string; calls: { tool: string; args: unknown; tag: string }[]; close(): Promise<void> };

function build(tag: string, log: Jsonl, calls: McpHandle["calls"]) {
  const s = new McpServer({ name: "spike-mcp", version: "0.0.1" });
  s.registerTool("ping", { description: "Health check. Returns the string pong.", inputSchema: {} }, async () => {
    calls.push({ tool: "ping", args: {}, tag });
    log.write({ ev: "tool", tool: "ping", tag });
    return { content: [{ type: "text", text: "pong" }] };
  });
  s.registerTool(
    "submit_result",
    {
      description: "Submit the final result of the task. Call it exactly once when done.",
      inputSchema: { summary: z.string().describe("short summary of the result") },
    },
    async (args) => {
      calls.push({ tool: "submit_result", args, tag });
      log.write({ ev: "tool", tool: "submit_result", tag, args });
      return { content: [{ type: "text", text: "result received" }] };
    },
  );
  return s;
}

/** Servidor MCP Streamable HTTP (sem estado) em 127.0.0.1, porta efemera. */
export async function startMcp(logName = "mcp"): Promise<McpHandle> {
  const log = new Jsonl(logName);
  const calls: McpHandle["calls"] = [];
  const srv: Server = createServer(async (req, res) => {
    const tag = (req.url ?? "/").split("/")[2] ?? "default";
    log.write({ ev: "http", method: req.method, url: req.url });
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const mcp = build(tag, log, calls);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/s`,
    calls,
    close: () => new Promise((r) => srv.close(() => r())),
  };
}
