import pLimit from "p-limit";

// Shared concurrency gate for the heavy render pipelines — the voiceover one
// (server/pipeline/processor.ts) and the no-voiceover one
// (server/automated-shorts/pipeline-no-voiceover.ts).
//
// Previously each file had its OWN pLimit(2), so a mixed batch could run 2+2=4
// uncoordinated pipelines and oversubscribe the box. One shared limiter keeps
// the total bounded no matter the mix.
//
// 3 concurrent on this 12-core machine: a large share of each pipeline is
// NETWORK WAIT (Gemini video analysis ~35s, plus script/hook calls) during
// which the CPU sits idle — so a 3rd pipeline's render fills those gaps and the
// batch drains faster. Crucially, NO encoder settings change here: every ffmpeg
// argument stays exactly as before, so each rendered video is byte-for-byte
// identical to what it would have been — only the batch throughput improves.
export const renderPipelineLimit = pLimit(3);
