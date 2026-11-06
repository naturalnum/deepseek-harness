import { fileURLToPath } from "node:url";
import { suitePaths } from "../src/server/paths.mjs";
console.log(
  JSON.stringify(
    {
      mcpServers: {
        "deepscientist-airalogy": {
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../dist/server/mcp.mjs", import.meta.url)),
          ],
          env: {
            DS_RESEARCH_DATA_DIR: suitePaths().directory,
          },
        },
      },
    },
    null,
    2,
  ),
);
