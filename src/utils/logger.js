'use strict';
const winston = require('winston');
const fs      = require('fs');

fs.mkdirSync('./data/logs',    { recursive: true });
fs.mkdirSync('./data/sessions',{ recursive: true });
fs.mkdirSync('./data/debug',   { recursive: true });

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const consoleFmt = printf(({ level, message, timestamp: ts, stack }) =>
  `${ts} [${level}] ${stack || message}`
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({
      format: combine(colorize({ all: true }), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), consoleFmt),
    }),
    new winston.transports.File({
      filename: './data/logs/app.log',
      format:   combine(timestamp(), errors({ stack: true }), json()),
      maxsize:  15_000_000, maxFiles: 5,
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

module.exports = logger;
