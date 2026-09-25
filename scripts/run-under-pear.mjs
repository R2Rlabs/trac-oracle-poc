// Runs another script of ours under the Pear/Bare runtime instead of Node.
//
// Trac's stack targets Bare: under Node, hypercore-storage (compact-encoding v2) and hyperschema
// (v3) end up in one process and writing synced state throws "Cannot read properties of null".
// Bare resolves the same tree the way Trac expects.
//
// Usage: node scripts/run-under-pear.mjs <script.mjs> [args…]
import { fileURLToPath } from 'url';
import path from 'path';

const [target, ...rest] = process.argv.slice(2);
if (!target) { console.error('Usage: node scripts/run-under-pear.mjs <script.mjs> [args…]'); process.exit(1); }

const entrypoint = path.resolve(process.cwd(), target);
const { default: PearRuntime } = await import('pear-runtime');

console.log(`Running ${path.basename(entrypoint)} under the Pear runtime…\n`);
const worker = PearRuntime.run(entrypoint, rest);

worker?.on?.('exit', (code) => process.exit(code ?? 0));
worker?.on?.('error', (err) => { console.error(`Pear runtime error: ${err.message}`); process.exit(1); });
