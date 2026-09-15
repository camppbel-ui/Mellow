'use strict';
/**
 * mock-server.js - stands in for the engine so you can test the client
 * without touching the Pi.
 *
 *   node mock-server.js shield_social
 *   node mock-server.js shield_all
 *   node mock-server.js clear
 *
 * Then point config.json at http://localhost:7777/api/enforcement
 */

const http = require('http');

const level = process.argv[2] || 'nudge';
const PORT = 7777;

const SAMPLES = {
  clear: { level: 'clear', blocking: false, shieldGroups: [], reasons: [] },
  nudge: {
    level: 'nudge', blocking: false, shieldGroups: [],
    reasons: [{ title: 'Read a book for 30 minutes', overdueFor: '12m', clearedBy: 'Run the 30-minute timer' }],
  },
  persistent: {
    level: 'persistent', blocking: false, shieldGroups: [],
    reasons: [{ title: 'Read a book for 30 minutes', overdueFor: '1h 02m', clearedBy: 'Run the 30-minute timer' }],
  },
  shield_social: {
    level: 'shield_social', blocking: true, shieldGroups: ['distractions'],
    reasons: [{ title: 'Read a book for 30 minutes', overdueFor: '1h 30m', clearedBy: 'Run the 30-minute timer' }],
  },
  shield_all: {
    level: 'shield_all', blocking: true, shieldGroups: ['distractions', 'games'],
    reasons: [
      { title: 'Read a book for 30 minutes', overdueFor: '3h 10m', clearedBy: 'Run the 30-minute timer' },
      { title: 'Clear flagged email', overdueFor: '2d 4h', clearedBy: 'Write 10 words on what you actioned' },
    ],
  },
};

const payload = SAMPLES[level];
if (!payload) {
  console.error(`Unknown level "${level}". Options: ${Object.keys(SAMPLES).join(', ')}`);
  process.exit(1);
}

http.createServer((req, res) => {
  if (!req.url.startsWith('/api/enforcement')) {
    res.writeHead(404); res.end('not found'); return;
  }
  const body = JSON.stringify({ ...payload, recheckInSeconds: 30 });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
  console.log(`served level=${payload.level}`);
}).listen(PORT, () => {
  console.log(`Mock engine on http://localhost:${PORT}/api/enforcement serving level="${level}"`);
});
