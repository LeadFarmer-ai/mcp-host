import { MCPClientCLI } from './cli-client.js'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({
  path: path.resolve(__dirname, '../.env'),
})

const cli = new MCPClientCLI({
  command: path.resolve(__dirname, '../index.js'),
  args: ['start'],
})

cli.start()
