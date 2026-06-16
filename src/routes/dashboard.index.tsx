import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PhoneCall, Users, CalendarCheck, TrendingUp, CheckCircle2, Clock } from "lucide-react";

export const Route = createFileRoute("/dashboard/")({ component: Overview });

type CallRow = {
  status: string;
  intent: string | null;
  appointment_time: string | null;
  duration_seconds: number | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
};

// Mirrors public.call_billable_seconds(calls). Counts billable seconds for our
// internal cost view: full talk time + ring window for completed calls, 30s
// flat for unanswered/busy, 0 for failed. Live calls use wall-clock since
// dial start, capped at 10 min.
function billableSeconds(c: CallRow): number {
  const created = new Date(c.created_at).getTime();
  const started = c.started_at ? new Date(c.started_at).getTime() : null;
  const ended = c.ended_at ? new Date(c.ended_at).getTime() : null;
  const dur = c.duration_seconds ?? 0;
  const ring = started ? Math.max(0, Math.round((started - created) / 1000)) : 0;

  let s = 0;
  switch (c.status) {
    case "completed":
      s = dur + Math.min(30, ring);
      break;
    case "voicemail":
      s = dur > 0
        ? dur
        : Math.min(60, ended ? Math.max(0, Math.round((ended - created) / 1000)) : 0);
      break;
    case "no_answer":
    case "busy":
      s = 30;
      break;
    case "declined": {
      const ref = started ?? ended;
      const ringRef = ref ? Math.max(0, Math.round((ref - created) / 1000)) : 0;
      s = Math.max(dur, 6) + Math.min(30, ringRef);
      break;
    }
    case "failed":
      s = 0;
      break;
    default:
      // live: dialing / ringing / in_progress / starting
      s = Math.min(600, Math.max(0, Math.round((Date.now() - created) / 1000)));
  }
  return Math.max(0, Math.min(3600, s));
}

function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function Overview() {
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    refetchInterval: 15000,
    queryFn: async () => {
      const [calls, patients, campaigns] = await Promise.all([
        supabase
          .from("calls")
          .select("status,intent,appointment_time,duration_seconds,created_at,started_at,ended_at", {
            count: "exact",
          }),
        supabase.from("patients").select("id", { count: "exact", head: true }),
        supabase.from("campaigns").select("id", { count: "exact", head: true }),
      ]);
      const rows = (calls.data ?? []) as CallRow[];
      const total = calls.count ?? 0;
      const connected = rows.filter((c) => c.status === "completed").length;
      const interested = rows.filter((c) => c.intent === "interested").length;
      const booked = rows.filter((c) => !!c.appointment_time).length;
      const conv = total > 0 ? Math.round((booked / total) * 100) : 0;
      const totalSeconds = rows.reduce((acc, r) => acc + billableSeconds(r), 0);
      return {
        total,
        connected,
        interested,
        booked,
        conv,
        totalSeconds,
        patients: patients.count ?? 0,
        campaigns: campaigns.count ?? 0,
      };
    },
  });

  const tiles = [
    { label: "Total calls", value: stats?.total ?? 0, icon: PhoneCall },
    { label: "Connected", value: stats?.connected ?? 0, icon: CheckCircle2 },
    {
      label: "Total call time",
      value: formatDuration(stats?.totalSeconds ?? 0),
      icon: Clock,
      sub: `${(stats?.totalSeconds ?? 0).toLocaleString()} sec billed`,
    },
    { label: "Interested", value: stats?.interested ?? 0, icon: Users },
    { label: "Appointments", value: stats?.booked ?? 0, icon: CalendarCheck },
    { label: "Conversion", value: `${stats?.conv ?? 0}%`, icon: TrendingUp },
  ];

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">Your campaign performance at a glance</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border bg-card p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{t.label}</span>
              <t.icon className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-3 text-2xl font-semibold">{t.value}</div>
            {"sub" in t && t.sub ? (
              <div className="mt-1 text-[11px] text-muted-foreground">{t.sub}</div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border bg-card p-6">
          <h3 className="font-semibold">Patients</h3>
          <p className="text-3xl font-semibold mt-2">{stats?.patients ?? 0}</p>
          <p className="text-sm text-muted-foreground mt-1">across all uploaded lists</p>
        </div>
        <div className="rounded-xl border bg-card p-6">
          <h3 className="font-semibold">Campaigns</h3>
          <p className="text-3xl font-semibold mt-2">{stats?.campaigns ?? 0}</p>
          <p className="text-sm text-muted-foreground mt-1">created so far</p>
        </div>
      </div>
    </div>
  );
}
