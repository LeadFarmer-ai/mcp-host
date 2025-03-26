import { MCPClientCLI } from './cli-client.js'
import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const npxPath = path.join(path.dirname(process.execPath), 'npx')

dotenv.config({
  path: path.resolve(__dirname, '../.env'),
})

const cli = new MCPClientCLI([
  {
    id: 'arithmetic-server',
    command: process.execPath,
    args: [path.resolve(__dirname, 'mcp-server-example.js')],
  },
  {
    id: 'slack-server',
    command: process.execPath,
    args: [
      path.resolve(
        __dirname,
        '../node_modules/@modelcontextprotocol/server-slack/dist/index.js',
      ),
    ],
    env: {
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? '',
      SLACK_TEAM_ID: process.env.SLACK_TEAM_ID ?? '',
    },
  },
])

cli.start()
