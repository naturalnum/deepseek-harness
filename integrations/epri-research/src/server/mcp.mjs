import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contracts, validateArgs } from "./contracts.mjs";
import { call } from "./client.mjs";
const server = new McpServer({
  name: "deepscientist-airalogy",
  version: "0.2.0",
});
for (const [op, c] of Object.entries(contracts))
  server.registerTool(
    "research_" + op,
    { description: c.description, inputSchema: c.shape },
    async (args, extra) => {
      try {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await call(op, validateArgs(op, args), extra.signal),
              ),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    },
  );
await server.connect(new StdioServerTransport());
