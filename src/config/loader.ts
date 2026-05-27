import * as fs from 'fs'
import * as yaml from 'js-yaml'
import { validateConfig, ParsedConfig } from './schema'

export async function loadConfig(): Promise<ParsedConfig> {
  const path = process.env.CONFIG_PATH ?? 'config/resilience.yaml'

  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch (err) {
    console.error('Config file not found: ' + path)
    process.exit(1)
  }

  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    console.error('YAML parse error: ' + (err as Error).message)
    process.exit(1)
  }

  let config: ParsedConfig
  try {
    config = validateConfig(parsed)
  } catch (err) {
    console.error('Config validation error: ' + (err as Error).message)
    process.exit(1)
  }

  return config
}
