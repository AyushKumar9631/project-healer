// Pull session recording metadata from Plivo REST and persist it to the
// `calls` row. This replaces the unreliable `<Record callbackUrl="...">`
// async webhook — Plivo often skips that callback when `<Record
// recordSession="true">` runs in parallel with `<Stream keepCallAlive="true">`,
// even though the recording itself uploads fine.
//
// Endpoint: GET /v1/Account/{AUTH_ID}/Call/{CallUUID}/Recording/
// Response shape (subset):
//   { api_id, meta, objects: [{
//       recording_id, recording_url, recording_duration, recording_type,
//       recording_start_ms, recording_end_ms, add_time, ... }] }

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { plivoGet } from "@/lib/plivo";

type PlivoRecording = {
  recording_id?: string;
  recording_url?: string;
  recording_duration?: number | string;
  recording_type?: string;
  recording_start_ms?: number | string;
  recording_end_ms?: number | string;
  add_time?: string;
};

type PlivoRecordingList = {
  objects?: PlivoRecording[];
  meta?: unknown;
  api_id?: string;
};

const RETRY_DELAYS_MS = [2000, 5000, 10000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickBest(objects: PlivoRecording[]): PlivoRecording | null {
  if (!objects.length) return null;
  const calls = objects.filter(
    (o) => (o.recording_type ?? "call").toLowerCase() === "call",
  );
  const pool = calls.length ? calls : objects;
  return pool.reduce<PlivoRecording | null>((best, cur) => {
    const bestDur = Number(best?.recording_duration ?? 0);
    const curDur = Number(cur.recording_duration ?? 0);
    return curDur > bestDur ? cur : best;
  }, null);
}

export async function fetchAndStorePlivoRecording(opts: {
  callId: string;
  callUuid: string;
  force?: boolean;
}): Promise<{ ok: boolean; reason?: string; recordingId?: string }> {
  const { callId, callUuid, force } = opts;

  if (!callUuid) return { ok: false, reason: "missing callUuid" };

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("calls")
    .select("id,clinic_id,recording_url")
    .eq("id", callId)
    .maybeSingle();
  if (rowErr) return { ok: false, reason: `lookup: ${rowErr.message}` };
  if (!row) return { ok: false, reason: "call row not found" };
  if (row.recording_url && !force) {
    return { ok: true, reason: "already set" };
  }

  let chosen: PlivoRecording | null = null;
  let lastErr = "";
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt]);
    try {
      const list = await plivoGet<PlivoRecordingList>(
        `/Call/${encodeURIComponent(callUuid)}/Recording/`,
      );
      const objects = list.objects ?? [];
      console.log(
        `[plivo-recording] callId=${callId} attempt=${attempt + 1} objects=${objects.length}`,
      );
      chosen = pickBest(objects);
      if (chosen?.recording_url) break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.warn(
        `[plivo-recording] callId=${callId} attempt=${attempt + 1} fetch failed: ${lastErr}`,
      );
    }
  }

  if (!chosen?.recording_url) {
    console.warn(
      `[plivo-recording] callId=${callId} no recording found after retries (${lastErr || "empty list"})`,
    );
    return { ok: false, reason: lastErr || "no recording yet" };
  }

  const durSeconds = Number(chosen.recording_duration ?? 0);
  await supabaseAdmin
    .from("calls")
    .update({
      recording_url: chosen.recording_url,
      recording_id: chosen.recording_id ?? null,
      recording_duration_seconds:
        Number.isFinite(durSeconds) && durSeconds > 0 ? Math.round(durSeconds) : null,
      recording_ready_at: new Date().toISOString(),
    })
    .eq("id", callId);

  await supabaseAdmin.from("call_events").insert({
    call_id: callId,
    clinic_id: row.clinic_id,
    event_type: "plivo_recording_fetched",
    payload: {
      RecordUrl: chosen.recording_url,
      RecordingID: chosen.recording_id ?? null,
      RecordingDuration: durSeconds,
      RecordingStartMs: Number(chosen.recording_start_ms ?? 0),
      RecordingEndMs: Number(chosen.recording_end_ms ?? 0),
      RecordingType: chosen.recording_type ?? null,
      AddTime: chosen.add_time ?? null,
      Source: "rest_poll",
    },
  });

  console.log(
    `[plivo-recording] callId=${callId} stored recordingId=${chosen.recording_id} duration=${durSeconds}s`,
  );
  return { ok: true, recordingId: chosen.recording_id };
}
