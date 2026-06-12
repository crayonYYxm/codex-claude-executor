/**
 * MCP Server entrypoint.
 *
 * Creates the configured server, connects to stdio transport,
 * and handles startup errors.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  try {
    // Create the configured server
    const server = createServer();

    // Create stdio transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);
  } catch (error) {
    // Log startup failures to stderr only
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}

main();
