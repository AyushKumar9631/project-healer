import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";

type TimingRow = {
  phase: string;
  t_offset_ms: number;
  duration_ms: number | null;
  detail: Record<string, unknown> | null;
  provider: string;
  direction: string;
};

export function CallLatencyWaterfall({ callId }: { callId: string }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["call_timings", callId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("call_timings")
        .select("phase, t_offset_ms, duration_ms, detail, provider, direction")
        .eq("call_id", callId)
        .order("t_offset_ms", { ascending: true });
      if (error) throw error;
      return (data ?? []) as TimingRow[];
    },
  });

  const max = useMemo(
    () => rows.reduce((m, r) => Math.max(m, r.t_offset_ms + (r.duration_ms ?? 0)), 1),
    [rows],
  );

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading timings…</div>;
  }
  if (!rows.length) {
    return (
      <div className="text-sm text-muted-foreground">
        No timing events recorded for this call yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        Total span: {(max / 1000).toFixed(2)}s · {rows.length} events ·{" "}
        {rows[0]?.provider} / {rows[0]?.direction}
      </div>
      <div className="space-y-1">
        {rows.map((r, i) => {
          const widthPct = Math.max(0.5, ((r.duration_ms ?? 30) / max) * 100);
          const offsetPct = Math.min(99, (r.t_offset_ms / max) * 100);
          return (
            <div key={i} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono truncate">{r.phase}</span>
                <span className="text-muted-foreground tabular-nums">
                  +{r.t_offset_ms}ms
                  {r.duration_ms != null ? ` · ${r.duration_ms}ms` : ""}
                </span>
              </div>
              <div className="relative h-2 bg-muted rounded">
                <div
                  className="absolute h-2 rounded bg-primary"
                  style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
