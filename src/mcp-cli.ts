import { runFactoryMcpCli } from "./mcp.js";

void runFactoryMcpCli(process.argv.slice(2)).catch((error: unknown) => {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
