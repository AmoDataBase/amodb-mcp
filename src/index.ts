#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

// stdout carries the protocol, so every diagnostic goes to stderr.
async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  if (!process.env.AMODB_API_KEY?.trim()) {
    console.error(`${SERVER_NAME} ${SERVER_VERSION}: AMODB_API_KEY is not set, tool calls will return an error.`);
  } else {
    console.error(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio.`);
  }
}

main().catch((err: unknown) => {
  console.error(`${SERVER_NAME} failed to start:`, err);
  process.exit(1);
});
