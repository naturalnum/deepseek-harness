import { build } from "esbuild";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
await mkdir("dist/ui", { recursive: true });
const alias = {
  "@/common/chat/reportChart":
    process.cwd() + "/src/reused/common/reportChart.ts",
  "@/common/chat/reportChartScene":
    process.cwd() + "/src/reused/common/reportChartScene.ts",
};
const backend = await build({
  entryPoints: [
    "src/server/main.mjs",
    "src/server/mcp.mjs",
    "src/server/service.mjs",
    "src/server/engine-runtime.mjs",
    "src/server/document-runtime.mjs",
  ],
  outdir: "dist/server",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  loader: { ".aimd":"text", ".toml":"text", ".py":"text" },
  external: ["@modelcontextprotocol/sdk/*", "zod", "yaml"],
  alias,
  sourcemap: true,
  metafile: true,
});
const frontend = await build({
  entryPoints: ["src/ui/main.tsx"],
  outfile: "dist/ui/app.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  loader: { ".module.css": "local-css", ".aimd": "text", ".toml":"text", ".py":"text" },
  sourcemap: true,
  metafile: true,
});
await writeFile(
  "dist/ui/index.html",
  '<!doctype html><html lang="zh"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepScientist · Research Studio</title><link rel="stylesheet" href="./app.css"><div id="root"></div><script src="./public-config.js"></script><script type="module" src="./app.js"></script></html>',
);
const client = await build({
  entryPoints: ["plugins/workbench/client.jsx"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["react", "react/jsx-runtime"],
  write: false,
});
await writeFile(
  "dist/client.js",
  'window.__ModuleLoader__.load({id:"deepscientist-harness-suite",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n' +
    client.outputFiles[0].text +
    "\nreturn module.exports;}});",
);
await copyFile(
  "examples/power-data-quality.aimd",
  "dist/server/example.aimd",
);
console.log(
  "Built backend, MCP, copied protocol UI and Harness client factory.",
);
await mkdir('dist/server/engine',{recursive:true});
for(const name of ['protocol_executor.py','workflow_executor.py','runner.py','LICENSE.airalogy']) await copyFile('src/reused/engine/'+name,'dist/server/engine/'+name);
await copyFile('src/server/document-native.py','dist/server/document-native.py');
await mkdir('source-records', {recursive:true});
await writeFile('source-records/build-inputs.json', JSON.stringify({backend:backend.metafile, frontend:frontend.metafile}, null, 2));
