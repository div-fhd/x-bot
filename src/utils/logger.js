'use strict';
const winston = require('winston');
const fs      = require('fs');

fs.mkdirSync('./data/logs',     { recursive: true });
fs.mkdirSync('./data/sessions', { recursive: true });
fs.mkdirSync('./data/debug',    { recursive: true });

// ── Custom levels ────────────────────────────────────────────
// Winston defaults: error(0) warn(1) info(2) http(3) debug(4)
// نضيف: success, action, retry بين info و http
const CUSTOM_LEVELS = {
  levels: {
    error:   0,
    warn:    1,
    info:    2,
    success: 3,  // ✓ عملية اكتملت بنجاح
    action:  4,  // ▶ بدء عملية (follow/like/tweet...)
    retry:   5,  // ↺ إعادة محاولة
    http:    6,
    debug:   7,
  },
  colors: {
    error:   'red bold',
    warn:    'yellow',
    info:    'cyan',
    success: 'green bold',
    action:  'magenta',
    retry:   'yellow bold',
    http:    'grey',
    debug:   'white',
  },
};

winston.addColors(CUSTOM_LEVELS.colors);

// ── Formats ──────────────────────────────────────────────────
const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const LEVEL_ICONS = {
  error:   '✗',
  warn:    '⚠',
  info:    '·',
  success: '✓',
  action:  '▶',
  retry:   '↺',
  http:    '~',
  debug:   '…',
};

const consoleFmt = printf(({ level, message, timestamp: ts, stack, tag }) => {
  const icon   = LEVEL_ICONS[level] || '·';
  const prefix = tag ? `[${tag}] ` : '';
  return `${ts} ${icon} ${prefix}${stack || message}`;
});

// ── Logger ───────────────────────────────────────────────────
const logger = winston.createLogger({
  levels:      CUSTOM_LEVELS.levels,
  level:       process.env.LOG_LEVEL || 'action',
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'HH:mm:ss' }),
        errors({ stack: true }),
        consoleFmt,
      ),
    }),
    new winston.transports.File({
      filename: './data/logs/app.log',
      format:   combine(timestamp(), errors({ stack: true }), json()),
      maxsize:  15_000_000,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: './data/logs/error.log',
      level:    'error',
      format:   combine(timestamp(), errors({ stack: true }), json()),
      maxsize:  5_000_000,
    }),
  ],
  exitOnError: false,
});

// ── logger.child({ tag }) ────────────────────────────────────
// const log = logger.child({ tag: 'FollowWorker' });
// log.action('بدء المتابعة...')  →  12:00:00 ▶ [FollowWorker] بدء المتابعة...
logger.child = (meta) => {
  const child = Object.create(logger);
  ['error','warn','info','success','action','retry','http','debug'].forEach(lvl => {
    child[lvl] = (msg, extra) => logger[lvl](msg, { ...meta, ...extra });
  });
  return child;
};

module.exports = logger;
