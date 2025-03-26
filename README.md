# MCP Host CLI

A demo cli client that you can connect MCP servers to and then query via your terminal.

## The Point

For me the point of this prototype is:

1. Creating your own MCP client as there are few examples and its sparsely documented (and for me I will need MCP clients for the systems I want to build)
2. Show how decoupled this in practice i.e. seeing that you can connect different MCP servers to your client and the client now knows how to do all manner of different things but there is no mention of any of these new capabilties in the client code at all.

## Not the Point

You won't see anything here that cannot be done with existing technology e.g. some other tool calling llm. Whats exciting about this is not the raw capabilities (we can all write a script to hit an api with an llm) it's the simple _way its organized_ in a decoupled understandable fashion.

And a growing ecosystem of [MCP Servers](https://github.com/modelcontextprotocol/servers?tab=readme-ov-file)...

## What is Model Context Protocol?

MCP is a standardized way of connecting an LLM you're working with to data sources and tools. It feels like connecting a device over USB-C. You are essentially plugging in a capability e.g. send emails, manage files on google drive, use a To Do list, make a dinner reservation. The MCP servers can be local e.g. cursor. Or they can be remote.

Another lens to look at it thru is the idea of a protocol. So you or I can write an open source MCP server and I could just use the one you wrote out of the box. So you could think of it like REST. REST didn't invent the idea of an API or communicating with servers, it just standardized a way of doing it that made sense to a lot of people.

## Why should we care?

From what I can see so far, the ease of use and the expanding ecosystem will be a real accelerator. So we should care because soon we'll be able to build agents more simply, more quickly, and more easily that do stuff in the real world. And on top of that there is this a great deal of free MCP lego blocks to play with.

## Dependencies

- [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) - Official Anthropic TypeScript SDK for Claude API interactions
- [@modelcontextprotocol/sdk](https://github.com/model-context-protocol/sdk-typescript) - Model Context Protocol SDK for tool server communication
- [chalk](https://github.com/chalk/chalk) - Terminal string styling for CLI output

## Resources

- [MCP Intro to the Protocol](https://modelcontextprotocol.io/introduction)
- [MCP Typescript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Servers](https://github.com/modelcontextprotocol/servers?tab=readme-ov-file)
- [LLM Context For Your IDE](https://modelcontextprotocol.io/llms-full.txt)

### Environment Variables

Required environment variables (see `.env.example`):

- `ANTHROPIC_API_KEY` - Your Anthropic API key for Claude access
- `SLACK_BOT_TOKEN` - Your Anthropic API key for Claude access
- `SLACK_TEAM_ID` - Your Anthropic API key for Claude access

## Getting Started

1. **Install Dependencies**

   ```bash
   npm install
   ```

2. **Configure Environment**

   - Copy `.env.example` to `.env`
   - Add your keys to `.env`

3. **Start the CLI Client**
   This will open a terminal window with a session running

   ```bash
   npm start
   ```

4. **Connect an MCP Server**
   The CLI client is configured to look for an MCP server at `./index.js`. You can:

   - Use the default server path in `cli.ts`
   - Or modify the server config when creating the CLI:
     ```typescript
     const cli = new MCPClientCLI([
       {
         command: 'path/to/your/server',
         args: ['start'],
         cwd: '/optional/working/directory',
       },
     ])
     ```

5. **Interact with Claude**
   - Type queries at the prompt
   - Claude will respond and use available tools
   - Type 'exit' to quit

## How Does the MCP Host Work?

Check the `host.ts` file. I added a lot of comments there to make it clear.

In general:

1. Connects to an LLM via the Anthropic client.
2. Connects to an MCP Server it is passed along with a user query via the CLI
3. Collects tools it can call from the MCP server
4. It decides what tools to use to answer the question & calls them
5. It passes the tool responses back to the LLM along with the user query
6. LLM decides whether to call more tools recursively or output a final answer
7. It streams the response to the CLI as it goes

### Limitations

- LLM is Claude but it could be abstracted to be any tool calling LLM
- Currently only supports text messages (no images/files)
- Messages are stored in memory (no persistence)
- If the data returned is very large it would at the least confuse the llm
- not really handling data responses very elegantly
- No error recovery for failed tool calls
- Single conversation context only
- The code could be improved

## How do MCP Servers Work

MCP Servers are like middleware that an LLM can understand how to use. They expose tools and they describe to the MCP Host what the tools do and how to call them. There is more but that is is the important part.

MCP Servers provide 3 things:

1. Tools: these are functions
2. Resources: this is data and it works like a REST endpoint
3. Prompts: this is a prompt template that the MCP Host can make use of to just keep the prompting more orgamized and under control

The MCP Server has a way of explaining to the LLM what those things are and how to call them e.g. schemas, descriptions.

### Tool Descriptions

I was stoked to see the way that tools are described by MCP servers is by `Zod` schema. You include a `.describe("The search term")` to say what the term is e.g. the first argument to a search function.

Example MCP server with a Search tool:

```
import { z } from "zod";
import { createServer } from "@modelcontextprotocol/sdk";
import { glob } from "glob";  // You'd need to npm install glob

const server = createServer();

// Define the input schema for the search_files tool
const SearchFilesInput = z.object({
  query: z.string().describe("The search term")
});

// Register the tool with the server
server.tool({
  name: "search_files",
  description: "Search for files in the workspace",
  inputSchema: SearchFilesInput,
  handler: async ({ query }) => {
    try {
      // Use glob to search for files matching the query
      const files = await glob(`**/*${query}*`, {
        ignore: ['node_modules/**', '.git/**'],
        nodir: true
      });

      return {
        files,
        count: files.length,
        message: `Found ${files.length} files matching "${query}"`
      };
    } catch (error) {
      throw new Error(`Failed to search files: ${error.message}`);
    }
  }
});


// Start the server
server.listen();

```

The tools description that gets sent back to our MCP Host client might look like this:

```
{
  tools: [
    {
      name: "search_files",
      description: "Search for files in the workspace",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search term"
          }
        },
        required: ["query"]
      }
    }
  ]
}
```

## Using the CLI

When you run `npm start`, you'll see an interactive terminal interface:

```
> MCP Host CLI
> Connected to MCP Server
> Tools available: [list of tools from server]
>
> You can start typing your queries...
>
```

Example interaction:

```
> What tools do you have available?

[Assistant will list available tools from the connected MCP server]

> Can you help me with...

[Assistant will respond and may use tools to help answer]
[Tool Call] tool_name {"arg": "value"}
[Tool Result] {"result": "data"}

> exit
Closing connections...
```

Tips:

- Type your questions/commands at the prompt
- Watch as Claude uses available tools to help answer
- Tool calls and results are color-coded for clarity
- Type 'exit' to quit the CLI

## Running an MCP Server

To test the client, you'll need an MCP server that provides tools. Here are a few options:

### Option 1: Use the Example Server

1. Clone the MCP example servers repository:

   ```bash
   git clone https://github.com/modelcontextprotocol/servers.git mcp-servers
   cd mcp-servers/typescript
   ```

2. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

3. Start the example server:
   ```bash
   npm start
   ```

This server provides basic example tools like calculator and weather lookup.

### Option 2: Create Your Own Server

1. Create a new TypeScript project:

   ```bash
   mkdir my-mcp-server
   cd my-mcp-server
   npm init -y
   ```

2. Install the MCP SDK:

   ```bash
   npm install @modelcontextprotocol/sdk
   ```

3. Create your server:

   - For a simple example to get started, check out `mcp-server-example.ts` in this repository
   - Try creating your own tools! Some ideas:
     - A calculator with different operations
     - A todo list manager
     - A weather lookup service
     - A file system navigator

   The MCP SDK makes it easy to define tools with input validation using Zod schemas and clear descriptions that LLMs can understand.

4. Build and run your server:
   ```bash
   npx tsc
   node dist/index.js
   ```

### Connecting to Your Server

Update the CLI configuration to point to your server:

```typescript
const cli = new MCPClientCLI({
  command: 'node',
  args: ['dist/index.js'], // Path to your server's entry point
  cwd: './my-mcp-server', // Directory where your server lives
})
```

Now when you run `npm start`, the client will connect to your local MCP server and have access to its tools.

## Key Components

### MCPClient

The main class that orchestrates all communication between Claude and tool servers. It handles:

- Message processing and history
- Tool call execution
- Stream management
- Error handling

### Anthropic Client

Manages communication with Claude API:

- Sends messages and receives responses
- Handles streaming responses
- Manages tool calling protocol

### MCP Client

Handles the Model Context Protocol (MCP):

- Connects to tool servers
- Lists available tools
- Executes tool calls
- Manages tool responses

### Transport

Manages stdio connections to tool servers:

- Starts server processes
- Handles command execution
- Manages working directories
- Processes arguments

### Message History

Maintains the conversation context:

- Stores user and assistant messages
- Tracks tool calls and results
- Manages conversation state

### Logger

Handles formatted output:

- Formats tool calls and responses
- Manages console styling
- Controls verbosity levels
- Error reporting
