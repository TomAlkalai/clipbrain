export const STYLES: Record<string, { accent: string; captionTop: number; hookTop: number; font: string; hookFontSize: number }> = {
  default: { accent: '#FFD84D', captionTop: 1180, hookTop: 260, font: 'Montserrat', hookFontSize: 70 },
  // QC's move_hook_up auto-fix (Task 13 fix round 1): the vision critic flagged the default hook
  // box sitting over a speaker's forehead/eyes in a 'face' crop layout. Moves the hook box much
  // higher (hookTop 110 vs 260) and shrinks its font ~15% (70 -> 60) so the smaller box still reads
  // cleanly near the top edge; captionTop is intentionally unchanged.
  'hook-high': { accent: '#FFD84D', captionTop: 1180, hookTop: 110, font: 'Montserrat', hookFontSize: 60 },
};
