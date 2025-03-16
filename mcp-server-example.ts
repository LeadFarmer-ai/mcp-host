import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

async function stop() {
  cleanup()
  process.exit(0)
}

async function cleanup() {
  try {
    if (server) {
      await server.close()
    }
    process.exit(0)
  } catch (error) {
    process.exit(1)
  }
}

process.on('uncaughtException', (error) => {
  cleanup()
})

// Create an MCP server
const server = new McpServer({
  name: 'Add',
  version: '1.0.0',
})

// Add an addition tool
server.tool(
  'add',
  {
    a: z.number().describe('First number to add').min(-1000).max(1000),
    b: z.number().describe('Second number to add').min(-1000).max(1000),
  },
  async ({ a, b }) => {
    return {
      content: [{ type: 'text', text: String(a + b) }],
    }
  },
)

server.tool(
  'multiply',
  {
    a: z.number().describe('number').min(-1000).max(1000),
    b: z.number().describe('amount to multiply by').min(-1000).max(1000),
  },
  async ({ a, b }) => {
    return {
      content: [{ type: 'text', text: String(a * b) }],
    }
  },
)

// Add a dynamic greeting resource
server.resource(
  'greeting',
  new ResourceTemplate('greeting://{name}', { list: undefined }),
  async (uri, { name }) => ({
    contents: [
      {
        uri: uri.href,
        text: `Hello, ${name}!`,
      },
    ],
  }),
)

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport()
await server.connect(transport)
