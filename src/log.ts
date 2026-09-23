function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function log(...a: unknown[]): void {
  console.error(`[${timestamp()}]`, ...a);
}

export function step(name: string): (extra?: string) => void {
  const start = Date.now();
  log(`${name}...`);
  return (extra?: string) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`${name} done in ${elapsed}s${extra ? ' — ' + extra : ''}`);
  };
}
