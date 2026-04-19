const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;

function fmt(level, args) {
  const ts = new Date().toISOString();
  return [`[${ts}] [${level.toUpperCase()}]`, ...args];
}

export const log = {
  debug: (...a) => currentLevel <= 10 && console.log(...fmt('debug', a)),
  info:  (...a) => currentLevel <= 20 && console.log(...fmt('info', a)),
  warn:  (...a) => currentLevel <= 30 && console.warn(...fmt('warn', a)),
  error: (...a) => currentLevel <= 40 && console.error(...fmt('error', a)),
};
