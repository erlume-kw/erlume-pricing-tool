import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const configPath = path.join(root, 'config.json');
export const dataDir = path.join(root, 'data');

// Strip // line comments and /* block */ comments from JSON text, while leaving
// anything inside "strings" untouched — so config.json can carry human notes.
function stripJsonComments(text) {
  let out = '';
  let inString = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

// Also tolerate a trailing comma before } or ] — common when editing by hand.
function stripTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

export function loadConfig() {
  const raw = readFileSync(configPath, 'utf8');
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
  } catch (err) {
    throw new Error(
      `config.json is not valid — check for a missing comma or quote. (${err.message})`
    );
  }
}
