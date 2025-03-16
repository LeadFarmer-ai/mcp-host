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
import util from 'util'

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
      throw error
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

    this.logger.log(
      consoleStyles.toolsAvailable(
        `======> MCP Tools available: ${this.tools
          .map((t) => t.name)
          .join(', ')}\n`,
      ),
    )
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
  ): Promise<void> {
    let currentMessage = ''
    let currentToolName = ''
    let currentToolInputString = ''

    this.logger.log(consoleStyles.assistant)
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'message_start':
        case 'content_block_stop':
          continue

        case 'content_block_start':
          if (chunk.content_block?.type === 'tool_use') {
            currentToolName = chunk.content_block.name
          }
          break

        case 'content_block_delta':
          if (chunk.delta.type === 'text_delta') {
            this.logger.log(chunk.delta.text)
            currentMessage += chunk.delta.text
          } else if (chunk.delta.type === 'input_json_delta') {
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

          if (chunk.delta.stop_reason === 'tool_use') {
            const toolArgs = currentToolInputString
              ? JSON.parse(currentToolInputString)
              : {}

            this.logger.log(
              this.formatToolCall(currentToolName, toolArgs) + '\n',
            )
            // console.log('======> Tool call: ' + currentToolName)
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

            // assuming text is the only content type
            const toolResultContent = toolResult.content
              .map((c) => c.text)
              .join('')

            const toolResultMessage = `Tool result returned for [${currentToolName}]: ${toolResultContent}`

            this.messages.push({
              role: 'assistant',
              content: toolResultMessage,
            })

            const nextStream = await this.anthropicClient.messages.create({
              messages: this.messages,
              model: 'claude-3-5-sonnet-20241022',
              max_tokens: 8192,
              tools: this.tools,
              stream: true,
            })
            await this.processStream(nextStream)
          }
          break

        case 'message_stop':
          break

        default:
          this.logger.log(`Unknown event type: ${JSON.stringify(chunk)}\n`, {
            type: 'warning',
          })
      }
    }
  }

  async processQuery(query: string) {
    try {
      this.messages.push({
        role: 'user',
        content: `
        Instructions on Answering the User Query:
        You will be given a list of tools and their arguments.
        You will need to use the tool(s) that are most likely to answer the user query.
        You can see over the history of the conversation if the tool has been called & the result returned.
        If it logically makes sense to call a tool again or call a different tool, then do so.
        If you see this as the last message: "Tool result returned for [toolName]: toolResultContent"
        This means that the tool has been called and the result has been returned.
        toolResultContent is the result of the tool call and what you should use to answer the User Query.
        There may be multiple tool calls in the conversation history and you should use all of their results to answer the User Query.
        Stop & consider the User Query and whether you need to call any more tools to answer it.
        If you have all the info you need in the history of the conversation and/or all the info you can get given the tools you have,
        then you can stop & return the answer to the User Query. Do not call any more tools.
        The answer should be based on the User Query and the tool results returned in the conversation history.
        The first thing you should do is consider the tools you have and make a plan on how to answer the User Query.
        Then in later steps you will have access to the plan you made so it will be easier to call the correct tools.
        If the User Query cannot be answered using the tools available, then you should return a message to the User Query that you cannot answer it.
        
        User Query: ${query}
        `,
      })

      const stream = await this.anthropicClient.messages.create({
        messages: this.messages,
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 8192,
        tools: this.tools,
        stream: true,
      })
      await this.processStream(stream)

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
