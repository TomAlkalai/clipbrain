import { doctor as runDoctor, setup as runSetup } from './tools/bins.js';
import { log } from './log.js';
import { llmJson, setBackend, ledgerSummary } from './llm/llm.js';
import { claudeBackend } from './llm/claude.js';

export type ParsedArgs = { _: string[]; flags: Record<string, string | boolean> };

export function parseArgs(argv: string[]): ParsedArgs {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else {
      _.push(arg);
    }
  }

  return { _, flags };
}

async function printDoctorReport(): Promise<boolean> {
  const rows = await runDoctor();
  let allOk = true;
  for (const row of rows) {
    if (!row.ok) allOk = false;
    const status = row.ok ? 'ok  ' : 'FAIL';
    console.log(`${status}  ${row.name}  ${row.detail}`);
  }
  return allOk;
}

export const commands: Record<string, { help: string; run: (a: ParsedArgs) => Promise<void> }> = {
  doctor: {
    help: 'Check that required tools and paths are available.',
    async run() {
      const ok = await printDoctorReport();
      if (!ok) process.exitCode = 1;
    },
  },
  setup: {
    help: 'Download required binaries and models, then run doctor.',
    async run() {
      await runSetup();
      const ok = await printDoctorReport();
      if (!ok) process.exitCode = 1;
    },
  },
  'llm-smoke': {
    help: 'Make one real LLM call (fast tier) and print the result and ledger summary.',
    async run() {
      setBackend(claudeBackend);
      const result = await llmJson<{ ok: boolean }>({
        tier: 'fast',
        purpose: 'smoke',
        system: 'You return JSON only.',
        prompt: 'Return ok=true.',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        noCache: true,
      });
      log('result:', JSON.stringify(result));
      log('ledger:', JSON.stringify(ledgerSummary()));
    },
  },
  ledger: {
    help: 'Print the LLM ledger summary as a table.',
    async run() {
      const s = ledgerSummary();
      log(`calls=${s.calls} cached=${s.cached} costUsd=${s.costUsd.toFixed(4)}`);
      console.log('purpose'.padEnd(24), 'calls'.padEnd(8), 'costUsd');
      for (const [purpose, v] of Object.entries(s.byPurpose)) {
        console.log(purpose.padEnd(24), String(v.calls).padEnd(8), v.costUsd.toFixed(4));
      }
    },
  },
};

function printHelp(): void {
  log('clipbrain — usage: cb <command> [...args]');
  log('commands:');
  for (const [name, cmd] of Object.entries(commands)) {
    log(`  ${name.padEnd(12)} ${cmd.help}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const [cmdName, ...rest] = parsed._;
  const cmd = cmdName ? commands[cmdName] : undefined;

  if (!cmd) {
    printHelp();
    if (cmdName) process.exitCode = 1;
    return;
  }

  await cmd.run({ _: rest, flags: parsed.flags });
}

main().catch((err) => {
  log('error:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
