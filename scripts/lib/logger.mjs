// scripts/lib/logger.mjs
// Structured JSON-line logger. Logs go to stdout (info/debug) or stderr (warn/error).
// Log management is delegated to the platform (GitHub Actions) – no file rotation.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

function getCurrentLevel() {
  const lvl = process.env.LOG_LEVEL?.toLowerCase() ?? 'info'
  return LEVELS[lvl] ?? LEVELS.info
}

function emit(level, source, message, fields = {}) {
  if (LEVELS[level] < getCurrentLevel()) return
  const line = JSON.stringify({ ts: new Date().toISOString(), level, source, message, ...fields })
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  stream.write(line + '\n')
}

export const logger = {
  debug: (source, message, fields) => emit('debug', source, message, fields),
  info: (source, message, fields) => emit('info', source, message, fields),
  warn: (source, message, fields) => emit('warn', source, message, fields),
  error: (source, message, fields) => emit('error', source, message, fields),
}
