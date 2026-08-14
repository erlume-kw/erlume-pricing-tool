// Internal price log — every priced bag gets saved here so the log becomes
// our own comp database over time (checked before hitting external APIs).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from './config.js';

const logPath = path.join(dataDir, 'price-log.json');

function readLog() {
  if (!existsSync(logPath)) return [];
  return JSON.parse(readFileSync(logPath, 'utf8'));
}

function writeLog(entries) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(logPath, JSON.stringify(entries, null, 2));
}

export function listEntries() {
  return readLog().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function addEntry(entry) {
  const entries = readLog();
  const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...entry };
  entries.push(record);
  writeLog(entries);
  return record;
}

export function deleteEntry(id) {
  const entries = readLog();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  writeLog(next);
  return true;
}

/** Find previously priced bags matching brand+model (internal comps). */
export function findComps(brand, model) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const b = norm(brand);
  const m = norm(model);
  if (!b || !m) return [];
  return readLog().filter((e) => norm(e.brand) === b && norm(e.model).includes(m));
}
