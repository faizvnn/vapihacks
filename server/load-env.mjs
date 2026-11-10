import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Local configuration is authoritative. Node's --env-file preserves inherited values,
// which can silently select a stale API key from the launching application's environment.
try {
  const local = parseEnv(readFileSync(resolve('.env'), 'utf8'));
  for (const [name, value] of Object.entries(local)) process.env[name] = value;
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Cannot read local .env configuration');
}
