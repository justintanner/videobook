import "dotenv/config";
import { z } from "zod";
import { fs } from "./fs.js";
import { queue } from "./queue.js";
import { getAllToolDefs, registerAllJobHandlers } from "./tools/index.js";

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseArgs(argv: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      console.error(`Invalid argument "${arg}". Use key=value format.`);
      process.exit(1);
    }
    args[arg.slice(0, eq)] = parseValue(arg.slice(eq + 1));
  }
  return args;
}

async function run(): Promise<void> {
  const [toolName, ...rest] = process.argv.slice(2);
  const tools = getAllToolDefs(fs);

  if (!toolName) {
    console.log("Usage: npm run use <tool> [key=value ...]\n");
    console.log("Available tools:");
    for (const t of tools) {
      const schemaObj = z.object(t.schema);
      const jsonSchema = schemaObj.toJSONSchema() as { required?: string[] };
      const required = new Set(jsonSchema.required ?? []);
      const params = Object.keys(t.schema)
        .map((k) => (required.has(k) ? `<${k}>` : `[${k}]`))
        .join(" ");
      console.log(`  ${t.name} ${params}`);
      if (t.description) console.log(`    ${t.description}`);
    }
    return;
  }

  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    console.error(`Unknown tool: ${toolName}`);
    process.exit(1);
  }

  const rawArgs = parseArgs(rest);
  const parsed = z.object(tool.schema).parse(rawArgs);

  registerAllJobHandlers();
  await queue.start();
  const result = await tool.handler(parsed as Record<string, unknown>);

  for (const item of result.content) {
    if (item.type === "text") {
      console.log(item.text);
    } else {
      console.log(JSON.stringify(item, null, 2));
    }
  }

  await queue.stop();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
