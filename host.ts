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
import { retryWithExponentialBackoff } from './retry.js'

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

// Update interface to support multiple servers
export interface MCPServerConfig extends StdioServerConfig {
  id: string
  env?: Record<string, string> // Optional environment variables for the server
}

// Update options to accept array of server configs
type MCPClientOptions = {
  servers: MCPServerConfig[]
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
  // Map to store MCP clients, transports, and tools for each server
  // we use a map so we can look up which server has the tool we need to call
  private servers: Map<
    string,
    {
      mcpClient: Client
      transport: StdioClientTransport
      tools: Tool[]
    }
  > = new Map()

  // Logger for the MCP Client
  private logger: Logger

  constructor({ servers, loggerOptions }: MCPClientOptions) {
    this.anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })

    this.logger = new Logger(loggerOptions ?? { mode: 'verbose' })

    // Initialize each server's components
    for (const config of servers) {
      const mcpClient = new Client(
        { name: `cli-client-${config.id}`, version: '1.0.0' },
        { capabilities: {} },
      )

      // Create a transport for each server
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
      })

      // Add the server to the map so we can call tools on it
      this.servers.set(config.id, {
        mcpClient,
        transport,
        tools: [],
      })
    }
  }

  // Connect to MCP server and initialize available tools
  async start() {
    try {
      // Start all servers in parallel
      await Promise.all(
        Array.from(this.servers.entries()).map(async ([id, server]) => {
          // Connect to the server
          await server.mcpClient.connect(server.transport)
          // Initialize the tools for the server
          const tools = await this.initMCPTools(server.mcpClient)
          // Add the tools to the server
          server.tools = tools
          // Log the tools available for the server
          this.logger.log(
            consoleStyles.toolsAvailable(
              `======> MCP Tools available for ${id}: ${tools
                .map((t) => t.name)
                .join(', ')}\n`,
            ),
          )
        }),
      )
    } catch (error) {
      this.logger.log('Failed to initialize MCP Client: ' + error + '\n', {
        type: 'error',
      })
      throw error
    }
  }

  async stop() {
    await Promise.all(
      Array.from(this.servers.values()).map((server) =>
        server.mcpClient.close(),
      ),
    )
  }

  // Calls the actual MCP server to get the list of tools & their schema descriptions
  private async initMCPTools(mcpClient: Client): Promise<Tool[]> {
    const toolsResults = await mcpClient.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    )
    return toolsResults.tools.map(({ inputSchema, ...tool }) => ({
      ...tool,
      input_schema: inputSchema,
    }))
  }

  // Helper to get all tools from all servers
  private getAllTools(): Tool[] {
    return Array.from(this.servers.values()).flatMap((server) => server.tools)
  }

  // Helper to find the right server for a given tool
  private getServerForTool(
    toolName: string,
  ): { mcpClient: Client } | undefined {
    for (const server of this.servers.values()) {
      if (server.tools.some((tool) => tool.name === toolName)) {
        return { mcpClient: server.mcpClient }
      }
    }
    return undefined
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
   * 5. Claude decides if it needs to call another tool or if it has all the info it needs to answer the User Query
   * 6. Process repeats if Claude makes another tool call
   *
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

        // a delta is a change to the message that could be a tool call or some text
        case 'message_delta':
          // if there is any text, add it to the message history
          if (currentMessage) {
            this.messages.push({
              role: 'assistant',
              content: currentMessage,
            })
          }
          // if the stop reason is a tool use, then we need to call the tool
          if (chunk.delta.stop_reason === 'tool_use') {
            // tool args will be a json string, so we need to parse it
            const toolArgs = currentToolInputString
              ? JSON.parse(currentToolInputString)
              : {}

            // log the tool call to the cli so we can see it
            this.logger.log(
              this.formatToolCall(currentToolName, toolArgs) + '\n',
            )

            // get the server for the tool from the map
            const server = this.getServerForTool(currentToolName)
            if (!server) {
              throw new Error(`No server found for tool: ${currentToolName}`)
            }

            // call the tool & await the result
            const toolResult = await server.mcpClient.request(
              {
                method: 'tools/call',
                params: {
                  name: currentToolName,
                  arguments: toolArgs, // the tool args is the json we got from the delta from claude
                },
              },
              CallToolResultSchema,
            )

            // assuming text is the only content type - which isn't true e.g. we could get json back
            const toolResultContent = toolResult.content
              .map((c) => c.text)
              .join('')

            // we identify the tool result with a special format so the llm knows it's a tool result
            // it was getting confused and calling the tool again even after the tool has already been called
            const toolResultMessage = `Tool result returned for [${currentToolName}]: ${toolResultContent}`
            this.logger.log(toolResultMessage + '\n')

            // add the tool result to the message history
            // this is important b/c many question will  have multiple tool calls
            // the llm will need to see the history of the conversation to know what the next step is
            this.messages.push({
              role: 'assistant',
              content: toolResultMessage,
            })

            // create a new stream with the updated message history
            // if the llm has stopped then there will be no more tool calls
            // & the stream will end b/c nextStream will not be called
            const nextStream = await retryWithExponentialBackoff(
              () =>
                this.anthropicClient.messages.create({
                  messages: this.messages,
                  model: 'claude-3-5-sonnet-20241022',
                  max_tokens: 8192,
                  tools: this.getAllTools(),
                  stream: true,
                }),
              {
                maxAttempts: 5,
                initialDelay: 2000,
                maxDelay: 15000,
              },
            )
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
        If the User Query cannot be answered using the tools available, then you should return a message to the User Query & say that you cannot answer it.
        
        User Query: ${query}
        `,
      })
      try {
        const stream = await retryWithExponentialBackoff(
          () =>
            this.anthropicClient.messages.create({
              messages: this.messages,
              model: 'claude-3-5-sonnet-20241022',
              max_tokens: 8192,
              tools: this.getAllTools(),
              stream: true,
            }),
          {
            maxAttempts: 5,
            initialDelay: 2000,
            maxDelay: 15000,
          },
        )
        await this.processStream(stream)
      } catch (error) {
        console.error('=========> Anthropic API call failed')
        throw error
      }

      return this.messages
    } catch (error) {
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
