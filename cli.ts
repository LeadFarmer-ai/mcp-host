import { MCPClientCLI } from './cli-client.js'
import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

dotenv.config({
  path: path.resolve(__dirname, '../.env'),
})

const cli = new MCPClientCLI({
  command: process.execPath,
  args: [path.resolve(__dirname, 'mcp-server-example.js')],
})

cli.start()
