import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { extractFromTranscript } from "@/lib/extractSymptoms";
import { formatUseCase } from "@/lib/playbooks/labels";
import { CallLatencyWaterfall } from "@/components/CallLatencyWaterfall";
import { supabase } from "@/integrations/supabase/client";

export interface CallRow {
  id: string;
  status: string;
  intent: string | null;
  condition_mentioned: string | null;
  appointment_time: string | null;
  callback_requested: boolean | null;
  callback_time: string | null;
  notes: string | null;
  transcript: { role: string; text: string; dropped_reason?: string; ts?: string }[];
  duration_seconds: number | null;
  created_at: string;
  recording_url?: string | null;
  recording_duration_seconds?: number | null;
  patients: { name: string; phone: string } | null;
  doctors: { name: string } | null;
  campaigns: { use_case: string } | null;
  call_outcomes?: { playbook_key: string }[] | null;
}

export function SelectedCallDetail({ call }: { call: CallRow }) {
  const { symptoms, vitals } = useMemo(
    () => extractFromTranscript(call.transcript),
    [call],
  );

  const useCaseKey =
    call.campaigns?.use_case ?? call.call_outcomes?.[0]?.playbook_key ?? null;

  return (
    <Tabs defaultValue="details" className="mt-6">
      <TabsList>
        <TabsTrigger value="details">Details</TabsTrigger>
        <TabsTrigger value="latency">Latency</TabsTrigger>
      </TabsList>
      <TabsContent value="details" className="space-y-4 mt-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Use case" value={formatUseCase(useCaseKey)} />
          <Field label="Status" value={call.status} />
          <Field label="Intent" value={call.intent} />
          <Field label="Topic" value={call.condition_mentioned} />
          <Field label="Doctor" value={call.doctors?.name} />
          <Field label="Duration" value={call.duration_seconds ? `${call.duration_seconds}s` : null} />
          <Field label="Appointment" value={call.appointment_time ? new Date(call.appointment_time).toLocaleString() : null} />
          <Field
            label="Callback"
            value={
              call.callback_time
                ? new Date(call.callback_time).toLocaleString()
                : call.callback_requested
                  ? "Yes — no time given"
                  : null
            }
          />
          <ChipsField label="Symptoms" items={symptoms} />
          <ChipsField label="Vitals shared" items={vitals} />
        </div>
        {call.recording_url ? (
          <RecordingPlayer callId={call.id} durationSeconds={call.recording_duration_seconds ?? null} />
        ) : (
          <BackfillRecordingButton callId={call.id} />
        )}
        {call.notes && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">Notes</div>
            <div className="text-sm bg-muted p-3 rounded-md">{call.notes}</div>
          </div>
        )}
        <div>
          <div className="text-xs text-muted-foreground mb-2">Transcript</div>
          <div className="space-y-2">
            {call.transcript?.map((t, i) => {
              const dropped = t.role === "patient" && !!t.dropped_reason;
              const droppedLabel =
                t.dropped_reason === "turn_in_flight"
                  ? "Heard while agent was replying"
                  : t.dropped_reason === "post_playout_guard"
                    ? "Heard while agent was finishing"
                    : null;
              return (
                <div
                  key={i}
                  className={`text-sm p-2 rounded-md ${
                    t.role === "agent"
                      ? "bg-accent"
                      : t.role === "system"
                        ? "bg-muted/40 border border-dashed border-muted-foreground/30 text-muted-foreground"
                        : dropped
                          ? "bg-muted/40 border border-dashed border-muted-foreground/30 text-muted-foreground"
                          : "bg-muted"
                  }`}
                >
                  <div className="text-xs font-medium text-muted-foreground mb-0.5 flex items-center gap-2">
                    <span>{t.role === "agent" ? "AI Agent" : t.role === "system" ? "System" : "Patient"}</span>
                    {droppedLabel && (
                      <Badge variant="outline" className="font-normal text-[10px] py-0 h-4">
                        {droppedLabel}
                      </Badge>
                    )}
                  </div>
                  {t.text}
                </div>
              );
            })}
          </div>
        </div>
      </TabsContent>
      <TabsContent value="latency" className="mt-4">
        <CallLatencyWaterfall callId={call.id} />
      </TabsContent>
    </Tabs>
  );
}


function RecordingPlayer({ callId, durationSeconds }: { callId: string; durationSeconds: number | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) { setError("Sign in required to play recordings"); return; }
        const res = await fetch(`/api/calls/recording?callId=${encodeURIComponent(callId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) { setError(`Failed to load recording (${res.status})`); return; }
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        revoke = url;
        setSrc(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [callId]);

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">
        Recording{durationSeconds ? ` · ${durationSeconds}s` : ""}
      </div>
      {error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : src ? (
        <audio controls src={src} className="w-full" preload="none" />
      ) : (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}
    </div>
  );
}

function BackfillRecordingButton({ callId }: { callId: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  const onClick = async () => {
    setStatus("loading");
    setMessage("");
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) { setStatus("error"); setMessage("Sign in required"); return; }
      const res = await fetch("/api/calls/backfill-recording", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ callId }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (res.ok && json.ok) {
        setStatus("ok");
        setMessage("Recording fetched. Reload to play.");
      } else {
        setStatus("error");
        setMessage(json.reason || `Failed (${res.status})`);
      }
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">Recording</div>
      <button
        type="button"
        onClick={onClick}
        disabled={status === "loading"}
        className="text-sm px-3 py-1.5 rounded-md border border-input bg-background hover:bg-accent disabled:opacity-50"
      >
        {status === "loading" ? "Fetching…" : "Fetch recording from Plivo"}
      </button>
      {message && (
        <div className={`text-xs mt-1 ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {message}
        </div>
      )}
    </div>
  );
}

function ChipsField({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {items.length === 0 ? (
        <div className="font-medium">—</div>
      ) : (
        <div className="flex flex-wrap gap-1 mt-1">
          {items.map((it) => (
            <Badge key={it} variant="secondary" className="font-normal">{it}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value ?? "—"}</div>
    </div>
  );
}
