export type Word = { w: string; start: number; end: number };
export type Sentence = { id: number; text: string; start: number; end: number; w0: number; w1: number };
export type Silence = { start: number; end: number };
export type Shot = { start: number; end: number };
export type FaceBox = { x: number; y: number; w: number; h: number; score: number }; // normalized, top-left origin
export type FaceSample = { t: number; faces: FaceBox[] };
export type Rect = { x: number; y: number; w: number; h: number }; // normalized

export type SignalName = 'hook' | 'standalone_clarity' | 'payoff' | 'novelty' | 'emotional_intensity' | 'information_density' | 'audience_fit';
export const SIGNALS: SignalName[] = ['hook', 'standalone_clarity', 'payoff', 'novelty', 'emotional_intensity', 'information_density', 'audience_fit'];
export type Scores = Record<SignalName, { score: number; reason: string }>;

export type Creator = {
  slug: string; name: string; channelUrl: string; referenceShortsUrls: string[];
  clippingPermission: string; publishChannelId?: string;
  layoutOverride?: { kind: 'stream'; cam: Rect; main: Rect };
  createdAt: string;
};

export type RefShort = { id: string; title: string; views: number; uploadDate: string; durationSec: number; channelUrl: string };
export type AlignedSegment = { shortStart: number; shortEnd: number; srcStart: number; srcEnd: number; tokens: number };
export type Alignment = { shortId: string; episodeId: string; segments: AlignedSegment[]; coverage: number; hits: number };
export type ShortFeatures = {
  shortId: string; episodeId: string; title: string; views: number; perf: number; // perf = ln(views/median)
  durationSec: number; srcSpanSec: number; nSegments: number; coldOpen: boolean; tightened: boolean;
  startsAfterPause: boolean; positionInEpisode: number; text: string; contextBefore: string;
};

export type Source = {
  id: string; creator: string; kind: 'youtube' | 'file'; url?: string; filePath?: string; videoId?: string;
  title: string; durationSec: number; width: number; height: number; createdAt: string;
};

export type Candidate = {
  id: string; sourceId: string; startSid: number; endSid: number; start: number; end: number;
  title: string; summary: string; why: string; patterns: string[]; scores: Scores; composite: number;
  rank?: number; rankReason?: string; shortlisted: boolean;
};

export type Hook = { text: string; pattern: string; score: number };
export type Layout =
  | { kind: 'face'; cx: number; cy: number; zoom: number }
  | { kind: 'split'; top: { cx: number; cy: number; zoom: number }; bottom: { cx: number; cy: number; zoom: number } }
  | { kind: 'fit' }
  | { kind: 'stream'; cam: Rect; main: Rect };
export type EdlSegment = { srcStart: number; srcEnd: number; layout: Layout }; // seconds in hi-res file
export type EdlCaption = { start: number; end: number; words: Word[] };   // output-timeline seconds
export type Edl = {
  fps: 30; width: 1080; height: 1920; videoSrc: string; srcAspect: number;
  segments: EdlSegment[]; captions: EdlCaption[];
  hook: { text: string; start: number; end: number } | null; durationSec: number; style: string;
};

export type QcCheck = { name: string; ok: boolean; detail: string; severity: 'error' | 'warn' };
export type QcReport = { ok: boolean; checks: QcCheck[]; fixesApplied: string[]; at: string };

export type ClipStatus = 'planned' | 'rendered' | 'qc_failed' | 'ready' | 'approved' | 'rejected' | 'published';
export type Clip = {
  id: string; sourceId: string; creator: string; candidateId: string;
  start: number; end: number;                    // source seconds (after snapping, before cold open)
  coldOpen: { start: number; end: number } | null;
  title: string; description: string; hashtags: string[];
  hooks: Hook[]; hookIndex: number;
  scores: Scores; composite: number; rankReason: string; patterns: string[];
  hiresOffset: number;                            // source second at hi-res file t=0
  edl?: Edl; qc?: QcReport; status: ClipStatus;
  review?: { decision: 'approved' | 'rejected'; reason?: string; at: string };
  publish?: { videoId: string; publishAt?: string; privacy: string; at: string; dryRun: boolean };
  metrics?: { at: string; views: number; engagedViews?: number; avgViewPct?: number; avgViewSec?: number; source: 'analytics' | 'public' | 'csv' }[];
  plannedPublishAt?: string; error?: string;
  renders: number; createdAt: string; updatedAt: string;
};

export type LedgerEntry = { at: string; tier: string; model: string; purpose: string; costUsd: number; ms: number; cached: boolean };
