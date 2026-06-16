import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Phone, PhoneOff, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface Patient {
  id: string;
  name: string;
  phone: string;
}

type Turn = { role: "agent" | "patient"; text: string };

export function LiveCallMonitor({
  patient,
  campaignId,
  onClose,
}: {
  patient: Patient;
  campaignId?: string;
  onClose: () => void;
}) {
  const [callId, setCallId] = useState<string | null>(null);
  const [twilioSid, setTwilioSid] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("starting");
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [hangingUp, setHangingUp] = useState(false);
  const [stuckWarning, setStuckWarning] = useState(false);

  const isTerminalStatus = (s: string) =>
    ["completed", "busy", "no_answer", "failed", "voicemail", "declined"].includes(s);

  // 90s watchdog: warn user when call appears stuck before reaching in_progress.
  useEffect(() => {
    setStuckWarning(false);
    if (isTerminalStatus(status) || status === "in_progress") return;
    const t = setTimeout(() => setStuckWarning(true), 90_000);
    return () => clearTimeout(t);
  }, [status]);

  // Auto-hangup if the user closes the dialog while the call is still live.
  async function handleCloseWithCleanup() {
    if (callId && !isTerminalStatus(status) && !hangingUp) {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (token) {
          await fetch("/api/calls/hangup", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ callId }),
          });
        }
      } catch {
        // closing anyway
      }
    }
    onClose();
  }

  // Start the call once on mount via the explicit HTTP route
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) throw new Error("You are not signed in. Please log in again.");

        const res = await fetch("/api/calls/start", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            patientId: patient.id,
            campaignId: campaignId ?? null,
          }),
        });

        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.error) {
          throw new Error(body?.error || `Start failed (${res.status})`);
        }

        if (cancelled) return;
        setCallId(body.callId);
        setTwilioSid(body.twilioSid ?? null);
        setStatus(body.twilioSid ? "dialing" : "starting");
        toast.success(`Calling ${patient.phone}…`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setBootError(msg);
        setStatus("failed");
        toast.error(msg);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to realtime updates on calls + poll as a fallback in case
  // realtime isn't enabled on the table or events get dropped.
  useEffect(() => {
    if (!callId) return;

    const applyRow = (row: { status?: string | null; transcript?: unknown; twilio_call_sid?: string | null }) => {
      if (row.status) setStatus(row.status);
      if (row.twilio_call_sid) setTwilioSid(row.twilio_call_sid);
      if (Array.isArray(row.transcript)) setTranscript(row.transcript as Turn[]);
    };

    const callChannel = supabase
      .channel(`call-${callId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "calls", filter: `id=eq.${callId}` },
        (payload) => applyRow(payload.new as Record<string, unknown>),
      )
      .subscribe();

    let cancelled = false;
    const poll = async () => {
      const { data } = await supabase
        .from("calls")
        .select("status,transcript,twilio_call_sid")
        .eq("id", callId)
        .maybeSingle();
      if (!cancelled && data) applyRow(data);
    };
    poll();
    const pollInterval = setInterval(poll, 3000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      supabase.removeChannel(callChannel);
    };
  }, [callId]);

  async function handleHangup() {
    if (!callId) {
      onClose();
      return;
    }
    setHangingUp(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("You are not signed in.");
      const res = await fetch("/api/calls/hangup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ callId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.error) throw new Error(body?.error || `Hangup failed (${res.status})`);
      toast.success("Hangup requested");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Hangup failed");
    } finally {
      setHangingUp(false);
    }
  }

  const isTerminal = isTerminalStatus(status);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="h-4 w-4" />
            Live call — {patient.name}
            <Badge
              variant={status === "failed" ? "destructive" : isTerminal ? "secondary" : "default"}
              className="ml-2"
            >
              {status}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        {bootError && (
          <div className="rounded-md bg-destructive/10 text-destructive text-sm p-3 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Call could not be started</div>
              <div className="text-xs mt-0.5 break-words">{bootError}</div>
            </div>
          </div>
        )}

        {stuckWarning && !isTerminal && (
          <div className="rounded-md bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 text-sm p-3 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Call appears stuck</div>
              <div className="text-xs mt-0.5">
                No connection update received in 90 seconds. The patient may have hung up.
                You can end the call below.
              </div>
            </div>
          </div>
        )}

        <div className="text-xs text-muted-foreground space-y-0.5">
          <div>Phone: <span className="font-mono">{patient.phone}</span></div>
          {callId && <div>Call ID: <span className="font-mono">{callId.slice(0, 8)}…</span></div>}
          {twilioSid && <div>Twilio SID: <span className="font-mono">{twilioSid.slice(0, 12)}…</span></div>}
        </div>

        <div className="border rounded-lg p-3 max-h-80 overflow-y-auto bg-muted/30 space-y-2">
          {!callId && !bootError ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Starting call…
            </div>
          ) : transcript.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {!isTerminal && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {status === "failed"
                ? "Call failed — no transcript."
                : status === "busy"
                ? "Patient line was busy."
                : status === "no_answer"
                ? "Patient did not answer."
                : status === "voicemail"
                ? "Reached voicemail — no message left."
                : status === "declined"
                ? "Patient hung up before the greeting finished."
                : status === "completed"
                ? "Call ended before any conversation."
                : status === "in_progress"
                ? "Connected — waiting for patient to speak…"
                : status === "ringing"
                ? "Ringing the patient…"
                : status === "dialing"
                ? "Dialing the patient…"
                : "Starting call…"}
            </div>
          ) : (
            transcript.map((t, i) => (
              <div key={i} className={`text-sm ${t.role === "agent" ? "text-foreground" : "text-primary"}`}>
                <span className="font-medium">{t.role === "agent" ? "Agent" : "Patient"}:</span> {t.text}
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={handleCloseWithCleanup}>
            Close
          </Button>
          <Button
            variant="destructive"
            onClick={handleHangup}
            disabled={hangingUp || isTerminal || !callId}
          >
            {hangingUp ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <PhoneOff className="h-4 w-4 mr-1" />}
            End call
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
