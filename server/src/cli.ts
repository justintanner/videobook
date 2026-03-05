import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { queue } from "./queue.js";

async function createClient(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: "clipfirst-cli", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

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

  const client = await createClient();

  if (!toolName) {
    const { tools } = await client.listTools();
    console.log("Usage: npm run use <tool> [key=value ...]\n");
    console.log("Available tools:");
    for (const t of tools) {
      const props = Object.entries(
        (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>
      );
      const required = new Set((t.inputSchema.required ?? []) as string[]);
      const params = props
        .map(([k]) => required.has(k) ? `<${k}>` : `[${k}]`)
        .join(" ");
      console.log(`  ${t.name} ${params}`);
      if (t.description) console.log(`    ${t.description}`);
    }
    await client.close();
    return;
  }

  const args = parseArgs(rest);
  await queue.start();
  const result = await client.callTool({ name: toolName, arguments: args });

  for (const item of result.content as Array<{ type: string; text?: string }>) {
    if (item.type === "text") {
      console.log(item.text);
    } else {
      console.log(JSON.stringify(item, null, 2));
    }
  }

  await client.close();
  await queue.stop();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
