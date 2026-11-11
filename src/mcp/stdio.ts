import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { App } from '../core/app.ts';
import { buildMcpServer } from './server.ts';

// stdout carries the protocol; never log to it.
console.log = console.error;

const app = new App();
const server = buildMcpServer(app);
await server.connect(new StdioServerTransport());
