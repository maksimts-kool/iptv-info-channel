import { dateFormatter } from './util.js';

function write(level, scope, message, details) {
  const timezone = process.env.TZ || 'Europe/Tallinn';
  const timestamp = dateFormatter('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date()).replace(' ', 'T');
  const suffix = details === undefined
    ? ''
    : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
  const line = `${timestamp} ${level.padEnd(5)} [${scope}] ${message}${suffix}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (scope, message, details) => write('INFO', scope, message, details),
  warn: (scope, message, details) => write('WARN', scope, message, details),
  error: (scope, message, details) => write('ERROR', scope, message, details),
};

export function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}
