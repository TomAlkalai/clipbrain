import { ffmpeg } from '../tools/bins.js';
import { spawnStream } from '../tools/proc.js';

export type ReadFramesOpts = { fps: number; width: number; height: number; start?: number; duration?: number };

/**
 * Streams raw RGB24 frames from `file` via ffmpeg at a fixed fps/size.
 * Yields each complete frame as it becomes available.
 */
export async function* readFrames(file: string, o: ReadFramesOpts): AsyncGenerator<{ t: number; rgb: Buffer }> {
  const { fps, width, height, start, duration } = o;
  const frameBytes = width * height * 3;
  const args: string[] = ['-hide_banner', '-loglevel', 'error'];
  if (start !== undefined) args.push('-ss', String(start));
  args.push('-i', file);
  if (duration !== undefined) args.push('-t', String(duration));
  args.push('-vf', `fps=${fps},scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');

  const child = spawnStream(ffmpeg(), args);

  const STDERR_TAIL_BYTES = 4096;
  let stderrTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  let buffered: Buffer = Buffer.alloc(0);
  let n = 0;
  let ended = false;
  let error: Error | undefined;
  let waiter: (() => void) | undefined;

  const wake = (): void => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w();
    }
  };

  child.stdout!.on('data', (d: Buffer) => {
    buffered = buffered.length === 0 ? d : Buffer.concat([buffered, d]);
    wake();
  });
  child.on('close', (code, signal) => {
    if (code !== 0 || signal) {
      error = new Error(
        `ffmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''} reading ${file}: ${stderrTail.trim()}`,
      );
    }
    ended = true;
    wake();
  });
  child.on('error', (err) => { error = err instanceof Error ? err : new Error(String(err)); ended = true; wake(); });

  try {
    while (true) {
      while (buffered.length >= frameBytes) {
        const rgb = Buffer.from(buffered.subarray(0, frameBytes));
        buffered = buffered.subarray(frameBytes);
        const t = (start ?? 0) + n / fps;
        n++;
        yield { t, rgb };
      }
      if (ended) break;
      await new Promise<void>((resolve) => { waiter = resolve; });
    }
  } finally {
    if (!ended) child.kill();
  }

  if (error) throw error;
}
