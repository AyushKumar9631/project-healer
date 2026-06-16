import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";

type TimingRow = {
  call_id: string;
  phase: string;
  duration_ms: number | null;
  detail: Record<string, unknown> | null;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function p95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

/**
 * Aggregate latency cards for the calls page.
 * Pulls the last `limit` calls' timing rows from the `call_timings` view and
 * computes p50/p95 of two key metrics plus the % of turns served by the
 * streaming sentence-loop path.
 */
export function CallLatencyCards({ limit = 200 }: { limit?: number }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["call_timings_agg", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("call_timings")
        .select("call_id, phase, duration_ms, detail")
        .in("phase", [
          "agent_turn_response",
          "reply_tts_first_byte",
          "reply_tts_done",
          "speculative_started",
          "speculative_resolved",
          "speculative_aborted",
        ])
        .order("created_at", { ascending: false })
        .limit(limit * 10);
      if (error) throw error;
      return (data ?? []) as TimingRow[];
    },
  });

  const stats = useMemo(() => {
    const turnMs: number[] = [];
    const ttsFirstByteMs: number[] = [];
    let streamedCount = 0;
    let totalReplies = 0;
    let specStarts = 0;
    let specReused = 0;
    let specResolved = 0;
    let specAborts = 0;
    for (const r of rows) {
      if (r.phase === "agent_turn_response" && typeof r.duration_ms === "number") {
        turnMs.push(r.duration_ms);
      } else if (r.phase === "reply_tts_first_byte") {
        const fetchMs = (r.detail as { fetch_ms?: number } | null)?.fetch_ms;
        if (typeof fetchMs === "number") ttsFirstByteMs.push(fetchMs);
      } else if (r.phase === "reply_tts_done") {
        totalReplies++;
        const streamed = (r.detail as { streamed?: boolean } | null)?.streamed;
        if (streamed) streamedCount++;
      } else if (r.phase === "speculative_started") {
        specStarts++;
      } else if (r.phase === "speculative_resolved") {
        specResolved++;
        if ((r.detail as { reuse?: boolean } | null)?.reuse) specReused++;
      } else if (r.phase === "speculative_aborted") {
        specAborts++;
      }
    }
    const reusePct = specResolved > 0 ? Math.round((specReused / specResolved) * 100) : null;
    return {
      turnP50: median(turnMs),
      turnP95: p95(turnMs),
      ttsP50: median(ttsFirstByteMs),
      ttsP95: p95(ttsFirstByteMs),
      streamedPct:
        totalReplies > 0 ? Math.round((streamedCount / totalReplies) * 100) : null,
      sampleTurns: turnMs.length,
      specStarts,
      specReused,
      specAborts,
      specReusePct: reusePct,
    };
  }, [rows]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
      <Card
        title="LLM turn latency"
        primary={fmtMs(stats.turnP50)}
        secondary={`p95 ${fmtMs(stats.turnP95)}`}
        hint={`${stats.sampleTurns} turns`}
        loading={isLoading}
      />
      <Card
        title="TTS first byte"
        primary={fmtMs(stats.ttsP50)}
        secondary={`p95 ${fmtMs(stats.ttsP95)}`}
        hint="ElevenLabs"
        loading={isLoading}
      />
      <Card
        title="Streaming reply"
        primary={stats.streamedPct == null ? "—" : `${stats.streamedPct}%`}
        secondary="Sentence-loop turns"
        hint="AGENT_STREAM_ENABLED"
        loading={isLoading}
      />
      <Card
        title="Speculative reuse"
        primary={stats.specReusePct == null ? "—" : `${stats.specReusePct}%`}
        secondary={`${stats.specReused}/${stats.specStarts} reused · ${stats.specAborts} aborts`}
        hint="AGENT_SPECULATIVE_ENABLED"
        loading={isLoading}
      />
    </div>
  );
}

function fmtMs(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${Math.round(v)}ms`;
}

function Card({
  title,
  primary,
  secondary,
  hint,
  loading,
}: {
  title: string;
  primary: string;
  secondary: string;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">
        {loading ? "…" : primary}
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">{secondary}</div>
      {hint && (
        <div className="text-[10px] text-muted-foreground/80 mt-2 uppercase tracking-wide">
          {hint}
        </div>
      )}
    </div>
  );
}
