import type { Clip } from '../types.js';

/**
 * True once a clip has really been uploaded: by status, or by a non-dry-run publish record,
 * which survives even if something later moves the status (a re-render resets it to
 * rendered/ready). Every path that could re-render or re-upload a clip checks this. Pure.
 */
export function isPublished(c: Clip): boolean {
  return c.status === 'published' || (c.publish !== undefined && c.publish.dryRun === false);
}
