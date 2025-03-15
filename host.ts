import { Anthropic } from '@anthropic-ai/sdk' // the client for anthropic used for caling tools & sending messages to the LLM
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js' // use this for the cli i/o
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js' // use this for the types
import { Client } from '@modelcontextprotocol/sdk/client/index.js' // use this for the mcp client interface
import chalk from 'chalk' // use this for the cli
import { Tool } from '@anthropic-ai/sdk/resources/index.mjs' // the type for the tools that the mcp servers share with this host
import { Stream } from '@anthropic-ai/sdk/streaming.mjs' // the type for the stream of messages from anthropic
import { consoleStyles, Logger, LoggerOptions } from './logger.js' // the logger for the cli

// Basic types for chat messages
interface Message {
  role: 'user' | 'assistant'
  content: string
}

// Add this interface near the top with other interfaces
interface StdioServerConfig {
  command: string // The command to start the MCP server
  args?: string[] // Optional arguments for the server command
  cwd?: string // Optional working directory for the server
}

// Update the MCPClientOptions type
type MCPClientOptions = StdioServerConfig & {
  loggerOptions?: LoggerOptions
}

/**
 * MCPClient - Main class that handles communication between Claude and MCP tools
 *
 * Limitations:
 * - Currently only supports text messages (no images/files)
 * - Messages are stored in memory (no persistence)
 * - No error recovery for failed tool calls
 * - Single conversation context only
 */
export class MCPClient {
  private anthropicClient: Anthropic // connection to claude - we use their client for tool calling
  private messages: Message[] = [] // In-memory message history
  private mcpClient: Client // the client itself
  private transport: StdioClientTransport // transport for the MCP client this 1:1 with each server
  private tools: Tool[] = [] // tools that the mcp servers share with the this host
  private logger: Logger

  constructor({
    // Logger configuration for controlling output verbosity and format
    loggerOptions,

    // Command to start the MCP server process
    // This could be a path to an executable or a shell command
    command,

    // Optional array of arguments to pass to the server command
    // Example: ['--port', '8080', '--config', 'config.json']
    args,

    // Optional working directory where the server process will be started
    // Useful for resolving relative paths and accessing server resources
    cwd,
  }: MCPClientOptions) {
    // Initialize Anthropic client for Claude API access
    this.anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })

    // Initialize MCP client that will handle tool communication
    this.mcpClient = new Client(
      { name: 'cli-client', version: '1.0.0' },
      { capabilities: {} },
    )

    // Initialize the transport with server config
    // This creates a connection to the MCP server via stdio
    this.transport = new StdioClientTransport({
      command,
      args,
      cwd,
    })

    this.logger = new Logger(loggerOptions ?? { mode: 'verbose' })
  }

  // Connect to MCP server and initialize available tools
  async start() {
    try {
      await this.mcpClient.connect(this.transport)
      await this.initMCPTools()
    } catch (error) {
      this.logger.log('Failed to initialize MCP Client: ' + error + '\n', {
        type: 'error',
      })
      process.exit(1)
    }
  }

  async stop() {
    await this.mcpClient.close()
  }

  // Fetch available tools from the MCP server
  private async initMCPTools() {
    const toolsResults = await this.mcpClient.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    )
    this.tools = toolsResults.tools.map(({ inputSchema, ...tool }) => ({
      ...tool,
      input_schema: inputSchema,
    }))
  }

  // CLI-specific formatting functions
  private formatToolCall(toolName: string, args: any): string {
    return (
      '\n' +
      consoleStyles.tool.bracket('[') +
      consoleStyles.tool.name(toolName) +
      consoleStyles.tool.bracket('] ') +
      consoleStyles.tool.args(JSON.stringify(args, null, 2)) +
      '\n'
    )
  }

  private formatJSON(json: string): string {
    return json
      .replace(/"([^"]+)":/g, chalk.blue('"$1":'))
      .replace(/: "([^"]+)"/g, ': ' + chalk.green('"$1"'))
  }

  /**
   * Core message processing logic
   *
   * This is how process the stream of messages and cycle thru all the tools,
   * & tool calls. So this is where the 'Agent' lives in the MCP Client
   *
   * Handles the streaming response from Claude, including:
   * 1. Regular text responses
   * 2. Tool calls
   * 3. Tool results being fed back to Claude
   *
   * The function processes one message at a time and can trigger new streams
   * when tool calls are involved. Tool calls work recursively:
   * 1. Claude makes a tool call
   * 2. We execute the tool and get results
   * 3. Results are added to message history
   * 4. A new Claude stream is created with updated history
   * 5. Process repeats if Claude makes another tool call
   *
   * To prevent infinite loops, we track the depth of recursive tool calls.
   * When MAX_TOOL_DEPTH is reached we ask for a final response
   * without allowing any more tool calls in case it just goes into a loop.
   *
   * The halt flag allows us to stop processing any further tool calls
   * This is different from depth in that it's an immediate stop signal
   * rather than a gradual limit
   */
  private async processStream(
    stream: Stream<Anthropic.Messages.RawMessageStreamEvent>,
    depth: number = 0,
    halt: boolean = false,
  ): Promise<void> {
    const MAX_TOOL_DEPTH = 10 // Maximum number of recursive tool calls allowed

    // If we've reached max depth or halt is requested, mark that we should stop tool calls
    // But continue processing the current stream
    if (depth >= MAX_TOOL_DEPTH || halt) {
      this.logger.log('Halting further tool calls', { type: 'warning' })
      halt = true // Ensure halt is set for the rest of this stream
    }

    let currentMessage = ''
    let currentToolName = ''
    let currentToolInputString = ''

    this.logger.log(consoleStyles.assistant)

    for await (const chunk of stream) {
      // Continue processing the stream normally
      // The halt flag will prevent new tool calls from being executed
      switch (chunk.type) {
        case 'message_start':
        case 'content_block_stop':
          // These events mark the start/end of message blocks
          // We don't need to process them directly
          continue

        case 'content_block_start':
          // Signals the start of a new content block
          // For tool calls, this tells us which tool Claude wants to use
          if (chunk.content_block?.type === 'tool_use') {
            currentToolName = chunk.content_block.name
          }
          break

        case 'content_block_delta':
          // Contains the actual content being streamed
          // Can be either regular text or tool input JSON
          if (chunk.delta.type === 'text_delta') {
            // Regular text response from Claude
            // We both display it and accumulate it
            this.logger.log(chunk.delta.text)
            currentMessage += chunk.delta.text
          } else if (chunk.delta.type === 'input_json_delta') {
            // Tool input parameters from Claude
            // We accumulate JSON fragments until we have the complete input
            if (currentToolName && chunk.delta.partial_json) {
              currentToolInputString += chunk.delta.partial_json
            }
          }
          break

        case 'message_delta':
          if (currentMessage) {
            this.messages.push({
              role: 'assistant',
              content: currentMessage,
            })
          }

          // Only attempt tool calls if we haven't halted
          if (chunk.delta.stop_reason === 'tool_use' && !halt) {
            // Parse accumulated tool input JSON
            const toolArgs = currentToolInputString
              ? JSON.parse(currentToolInputString)
              : {}

            // Execute the tool call and get results
            this.logger.log(
              this.formatToolCall(currentToolName, toolArgs) + '\n',
            )
            const toolResult = await this.mcpClient.request(
              {
                method: 'tools/call',
                params: {
                  name: currentToolName,
                  arguments: toolArgs,
                },
              },
              CallToolResultSchema,
            )

            // Format and save tool results to conversation history
            const formattedResult = this.formatJSON(
              JSON.stringify(toolResult.content.flatMap((c) => c.text)),
            )
            this.messages.push({
              role: 'user',
              content: formattedResult,
            })

            // Start another round with tool results
            // This creates a new stream with the updated history
            // allowing Claude to see the tool results and continue the conversation
            const nextStream = await this.anthropicClient.messages.create({
              messages: this.messages,
              model: 'claude-3-5-sonnet-20241022',
              max_tokens: 8192,
              tools: this.tools,
              stream: true,
            })
            // Process the new stream, incrementing depth to track tool call nesting
            await this.processStream(nextStream, depth + 1, halt)
          } else if (chunk.delta.stop_reason === 'tool_use' && halt) {
            // If we hit a tool call while halted, inform Claude to continue without tools
            this.messages.push({
              role: 'user',
              content: 'Please continue your response without using tools.',
            })
            const nextStream = await this.anthropicClient.messages.create({
              messages: this.messages,
              model: 'claude-3-5-sonnet-20241022',
              max_tokens: 8192,
              stream: true, // Note: not passing tools here
            })
            await this.processStream(nextStream, depth, true)
          }
          break

        case 'message_stop':
          // Normal completion of a message without tool calls
          break

        default:
          // Log unexpected event types for debugging
          this.logger.log(`Unknown event type: ${JSON.stringify(chunk)}\n`, {
            type: 'warning',
          })
      }
    }
  }

  /**
   * Main entry point for processing user queries
   * Creates a new Claude API stream and processes the response
   * Each new query resets the tool call depth counter and halt state
   */
  async processQuery(query: string) {
    try {
      this.messages.push({ role: 'user', content: query })

      const stream = await this.anthropicClient.messages.create({
        messages: this.messages,
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 8192,
        tools: this.tools,
        stream: true,
      })
      // Start fresh with depth 0 and no halt for each new query
      await this.processStream(stream, 0, false)

      return this.messages
    } catch (error) {
      this.logger.log('\nError during query processing: ' + error + '\n', {
        type: 'error',
      })
      if (error instanceof Error) {
        this.logger.log(
          consoleStyles.assistant +
            'I apologize, but I encountered an error: ' +
            error.message +
            '\n',
        )
      }
    }
  }
}
