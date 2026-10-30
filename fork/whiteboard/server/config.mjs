// Loads the service configuration, merging ~/.whiteboard/config.json over defaults.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const base = `${homedir()}/.whiteboard`
let overrides = {}
try { overrides = JSON.parse(readFileSync(`${base}/config.json`, 'utf8')) } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
/** @type {{dataDir: string, host: string, port: number, webPort: number, chatPort: number, allowedHosts: string[], openViews: Record<string, 'board' | 'chat'>}} */
export const config = { dataDir: `${base}/data`, host: '127.0.0.1', port: 6060, webPort: 6061, chatPort: 6070, allowedHosts: [], openViews: {}, ...overrides }
