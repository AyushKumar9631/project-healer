import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  PhoneCall,
  Loader2,
  Users,
  Activity,
  CheckCircle2,
  Target,
  Play,
  Pause,
  RefreshCcw,
  CalendarClock,
} from "lucide-react";
import { LiveCallMonitor } from "@/components/LiveCallMonitor";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/campaigns/$campaignId")({
  component: CampaignDetail,
});

interface Patient {
  id: string;
  name: string;
  phone: string;
  age: number | null;
  gender: string | null;
  bp: string | null;
  blood_sugar: string | null;
  health_camp: string | null;
  risk: string | null;
}

function CampaignDetail() {
  const { campaignId } = Route.useParams();
  const qc = useQueryClient();
  const [callPatient, setCallPatient] = useState<Patient | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<string>("all");
  const [riskFilter, setRiskFilter] = useState<string>("all");
  const [scheduleDateTime, setScheduleDateTime] = useState<string>("");

  const { data: campaign } = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: async () => {
      const { data } = await supabase
        .from("campaigns")
        .select("*, patient_lists(name)")
        .eq("id", campaignId)
        .maybeSingle();
      return data;
    },
  });

  const { data: patients = [] } = useQuery({
    queryKey: ["campaign-patients", campaign?.patient_list_id],
    enabled: !!campaign?.patient_list_id,
    queryFn: async () => {
      const { data } = await supabase
        .from("patients")
        .select("*")
        .eq("patient_list_id", campaign!.patient_list_id!)
        .order("created_at");
      return (data ?? []) as Patient[];
    },
  });

  const { data: calls = [] } = useQuery({
    queryKey: ["campaign-calls", campaignId],
    refetchInterval: 2000,
    queryFn: async () => {
      const { data } = await supabase
        .from("calls")
        .select("id,patient_id,status,intent,created_at")
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: true });
      return data ?? [];
    },
  });

  const { data: queueItems = [] } = useQuery({
    queryKey: ["campaign-queue", campaignId],
    refetchInterval: 2000,
    queryFn: async () => {
      const { data } = await supabase
        .from("campaign_call_queue")
        .select("id, patient_id, status, outcome, retry_count")
        .eq("campaign_id", campaignId);
      return data ?? [];
    },
  });

  const callByPatient = useMemo(() => {
    const m = new Map<string, { status: string; intent: string | null }>();
    for (const c of calls) m.set(c.patient_id, { status: c.status, intent: c.intent });
    return m;
  }, [calls]);

  const queueByPatient = useMemo(() => {
    const m = new Map();
    for (const q of queueItems) m.set(q.patient_id, q);
    return m;
  }, [queueItems]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["campaign-calls", campaignId] });
    qc.invalidateQueries({ queryKey: ["campaign-queue", campaignId] });
    qc.invalidateQueries({ queryKey: ["campaign", campaignId] });
  };

  // --- NEW: Handle Saving the Schedule ---
  const saveCampaignSchedule = useMutation({
    mutationFn: async (timestamp: string | null) => {
      const { error } = await supabase
        .from("campaigns")
        .update({
          scheduled_at: timestamp ? new Date(timestamp).toISOString() : null,
        })
        .eq("id", campaignId);
      if (error) throw error;
      return true;
    },
    onSuccess: (_, timestamp) => {
      if (timestamp) {
        toast.success("Schedule saved! Automation will trigger at the set time.");
      } else {
        toast.info("Schedule cleared.");
      }
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // --- Handle Manual Stuck Call Reset ---
  const resetStuckCalls = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("campaign_call_queue")
        .update({
          status: "retry_scheduled",
          call_id: null,
          last_error: "Manually reset from dashboard",
        })
        .eq("campaign_id", campaignId)
        .in("status", ["dialing", "in_progress"]);

      if (error) throw error;
      return true;
    },
    onSuccess: () => {
      toast.success("Stuck calls moved to retry scheduled!");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const startCampaignAutomation = useMutation({
    mutationFn: async () => {
      // --- NEW: Automatically sweep stuck calls before doing anything else ---
      await supabase
        .from("campaign_call_queue")
        .update({
          status: "retry_scheduled",
          call_id: null,
          last_error: "Auto-reset prior to engine launch",
        })
        .eq("campaign_id", campaignId)
        .in("status", ["dialing", "in_progress"]);

      // 1. Get the campaign details directly
      const { data: campaignData, error: campaignErr } = await supabase
        .from("campaigns")
        .select("patient_list_id, clinic_id")
        .eq("id", campaignId)
        .single();

      if (campaignErr) throw new Error("Could not find campaign details.");

      // 2. Fetch the patients to process
      let patientsQuery = supabase.from("patients").select("id, phone, risk");
      if (campaignData.patient_list_id) {
        patientsQuery = patientsQuery.eq("patient_list_id", campaignData.patient_list_id);
      } else if (campaignData.clinic_id) {
        patientsQuery = patientsQuery.eq("clinic_id", campaignData.clinic_id);
      }
      const { data: campaignPatients, error: patientsErr } = await patientsQuery;
      if (patientsErr) throw new Error("Could not fetch patients.");

      // 3. Fetch the existing queue
      const { data: existingQueue, error: queueErr } = await supabase
        .from("campaign_call_queue")
        .select("id, patient_id, status")
        .eq("campaign_id", campaignId);

      if (queueErr) throw new Error("Could not fetch the current queue.");

      const existingPatientIds = new Set(existingQueue?.map((q) => q.patient_id) || []);

      // 4. Figure out brand new patients and apply the risk filter
      let newPatients =
        campaignPatients?.filter((p) => p.phone && !existingPatientIds.has(p.id)) || [];
      if (riskFilter && riskFilter !== "all") {
        newPatients = newPatients.filter((p) => p.risk?.toLowerCase() === riskFilter.toLowerCase());
      }

      // Insert new patients
      if (newPatients.length > 0) {
        const queueInserts = newPatients.map((p) => ({
          campaign_id: campaignId,
          patient_id: p.id,
          clinic_id: campaignData.clinic_id,
          phone_number: p.phone,
          status: "pending",
        }));
        const { error: insertErr } = await supabase
          .from("campaign_call_queue")
          .insert(queueInserts);
        if (insertErr) throw new Error("Failed to add new patients to queue.");
      }

      // 5. Reactivate failed/missed patients
      const patientsToReactivate =
        existingQueue?.filter((q) => q.status === "failed" || q.status === "retry_scheduled") || [];

      // Apply the exact same risk filter to the reactivated patients
      const reactivateIds = patientsToReactivate
        .filter((q) => {
          if (!riskFilter || riskFilter === "all") return true;
          const patient = campaignPatients?.find((p) => p.id === q.patient_id);
          return patient?.risk?.toLowerCase() === riskFilter.toLowerCase();
        })
        .map((q) => q.id);

      if (reactivateIds.length > 0) {
        const { error: updateErr } = await supabase
          .from("campaign_call_queue")
          .update({
            status: "pending",
            call_id: null,
            last_error: null,
          })
          .in("id", reactivateIds);
        if (updateErr) throw new Error("Failed to reactivate past calls.");
      }

      // 6. Set the campaign status to 'running' to trigger the Railway Worker
      const { error: statusErr } = await supabase
        .from("campaigns")
        .update({ status: "running" })
        .eq("id", campaignId);

      if (statusErr) throw new Error("Failed to start campaign engine.");

      return true;
    },
    onSuccess: () => {
      toast.success("Campaign automation started! Calls will begin shortly.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pauseCampaign = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("campaigns")
        .update({ status: "paused" })
        .eq("id", campaignId);
      if (error) throw error;
      return true;
    },
    onSuccess: () => {
      toast.info("Campaign Paused. Active calls will drain naturally.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const enrichedPatients = useMemo(() => {
    return patients.map((p) => {
      const call = callByPatient.get(p.id);
      const queueItem = queueByPatient.get(p.id);
      let displayStatus = "pending";
      let displayIntent = null;
      let retries = 0;

      if (queueItem) {
        displayStatus = queueItem.status;
        displayIntent = queueItem.outcome ?? call?.intent ?? null;
        retries = queueItem.retry_count ?? 0;
      } else if (call) {
        displayStatus = call.status;
        displayIntent = call.intent;
      }

      return {
        ...p,
        callStatus: displayStatus,
        callIntent: displayIntent,
        retryCount: retries,
      };
    });
  }, [patients, callByPatient, queueByPatient]);

  const completedCount = enrichedPatients.filter((p) => p.callStatus === "completed").length;
  const pendingCount = enrichedPatients.filter((p) => p.callStatus === "pending").length;
  const activeCount = enrichedPatients.filter(
    (p) => p.callStatus === "dialing" || p.callStatus === "in_progress",
  ).length;
  const failedCount = enrichedPatients.filter((p) => p.callStatus === "failed").length;

  const successCount = enrichedPatients.filter(
    (p) => p.callIntent === "interested" || p.callIntent === "appointment_booked",
  ).length;

  const successRate =
    completedCount + failedCount > 0
      ? Math.round((successCount / (completedCount + failedCount)) * 100)
      : 0;

  const pct = patients.length ? (completedCount / patients.length) * 100 : 0;

  const queueList = enrichedPatients.filter(
    (p) => p.callStatus !== "completed" && p.callStatus !== "failed",
  );

  const outcomesList = enrichedPatients.filter(
    (p) => p.callStatus === "completed" || p.callStatus === "failed",
  );

  const dynamicOutcomes = useMemo(() => {
    const uniqueTags = new Set<string>();
    outcomesList.forEach((patient) => {
      if (patient.callIntent) uniqueTags.add(patient.callIntent);
      else if (patient.callStatus === "failed") uniqueTags.add("failed");
    });
    return Array.from(uniqueTags).sort();
  }, [outcomesList]);

  const filteredOutcomes = outcomesList.filter((p) => {
    if (outcomeFilter === "all") return true;
    if (outcomeFilter === "failed" && !p.callIntent) return p.callStatus === "failed";
    return p.callIntent === outcomeFilter;
  });

  const MetricCard = ({ title, value, icon: Icon, highlight = false }: any) => (
    <div
      className={`bg-card border rounded-xl p-5 flex flex-col gap-3 shadow-sm ${highlight ? "border-blue-200 bg-blue-50/30" : ""}`}
    >
      <div className="flex items-center justify-between text-muted-foreground text-xs font-semibold tracking-wider uppercase">
        {title}
        <Icon className={`h-4 w-4 ${highlight ? "text-blue-500" : "opacity-70"}`} />
      </div>
      <div className={`text-3xl font-semibold ${highlight ? "text-blue-600" : "text-foreground"}`}>
        {value}
      </div>
    </div>
  );

  const PatientTable = ({ data }: { data: typeof enrichedPatients }) => (
    <div className="border rounded-xl bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs">
          <tr>
            <th className="text-left p-3">Name</th>
            <th className="text-left p-3">Phone</th>
            <th className="text-left p-3">BP</th>
            <th className="text-left p-3">Sugar</th>
            <th className="text-left p-3">Status</th>
            <th className="text-right p-3">Action</th>
          </tr>
        </thead>
        <tbody>
          {data.map((p) => {
            const isActive = p.callStatus === "dialing" || p.callStatus === "in_progress";
            const riskLower = p.risk?.toLowerCase() || "low";
            const riskColorClass =
              riskLower === "high"
                ? "bg-red-50 text-red-700 border-red-100"
                : riskLower === "moderate" || riskLower === "medium"
                  ? "bg-amber-50 text-amber-700 border-amber-100"
                  : "bg-emerald-50 text-emerald-700 border-emerald-100";

            return (
              <tr
                key={p.id}
                className={`border-t transition-colors ${isActive ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}`}
              >
                <td className="p-3">
                  <div className="flex flex-col items-start gap-1">
                    <div className="font-medium flex items-center gap-2">
                      {p.name}
                      {isActive && (
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                        </span>
                      )}
                    </div>
                    <span
                      className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-medium border ${riskColorClass}`}
                    >
                      {p.risk ? `${p.risk} Risk` : "Low Risk"}
                    </span>
                  </div>
                </td>
                <td className="p-3 font-mono text-xs">{p.phone}</td>
                <td className="p-3">{p.bp ?? " "}</td>
                <td className="p-3">{p.blood_sugar ?? " "}</td>
                <td className="p-3">
                  <Badge
                    variant={
                      p.callStatus === "completed"
                        ? "default"
                        : p.callStatus === "failed"
                          ? "destructive"
                          : isActive
                            ? "default"
                            : "secondary"
                    }
                    className={`capitalize ${isActive ? "bg-blue-500 hover:bg-blue-600 text-white" : ""}`}
                  >
                    {isActive && <Loader2 className="h-3 w-3 mr-1.5 animate-spin inline-block" />}
                    {p.callStatus.replace("_", " ")}
                    {p.callIntent ? ` - ${p.callIntent.replace(/_/g, " ")}` : ""}
                    {p.retryCount > 0 && p.callStatus !== "completed"
                      ? ` (Retry ${p.retryCount})`
                      : ""}
                  </Badge>
                </td>
                <td className="p-3 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCallPatient(p)}
                    disabled={p.callStatus === "completed" || isActive}
                  >
                    <PhoneCall className="h-3.5 w-3.5 mr-1" /> Start call
                  </Button>
                </td>
              </tr>
            );
          })}
          {data.length === 0 && (
            <tr>
              <td colSpan={6} className="p-6 text-center text-sm text-muted-foreground">
                No patients match this view.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="p-8 space-y-6">
      <Link
        to="/dashboard/campaigns"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to campaigns
      </Link>

      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{campaign?.name ?? "Campaign"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {(campaign as any)?.patient_lists?.name} - {campaign?.use_case?.replace(/_/g, " ")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* --- POLISHED SCHEDULE BLOCK --- */}
          <div className="flex items-center gap-2 border shadow-sm rounded-md px-3 h-9 bg-card hover:bg-accent/30 transition-colors focus-within:ring-1 focus-within:ring-emerald-500/50">
            <CalendarClock className="h-4 w-4 text-emerald-600" />

            <div className="relative flex items-center">
              <input
                type="datetime-local"
                value={
                  scheduleDateTime ||
                  ((campaign as any)?.scheduled_at
                    ? new Date(
                        new Date((campaign as any).scheduled_at).getTime() -
                          new Date().getTimezoneOffset() * 60000,
                      )
                        .toISOString()
                        .slice(0, 16)
                    : "")
                }
                onChange={(e) => setScheduleDateTime(e.target.value)}
                disabled={campaign?.status === "running"}
                className="text-sm font-medium bg-transparent border-none focus:outline-none text-foreground cursor-pointer w-[155px]
                  /* Hide the default browser icon but stretch its hit-box across the input */
                  [&::-webkit-calendar-picker-indicator]:opacity-0 
                  [&::-webkit-calendar-picker-indicator]:absolute 
                  [&::-webkit-calendar-picker-indicator]:inset-0 
                  [&::-webkit-calendar-picker-indicator]:w-full 
                  [&::-webkit-calendar-picker-indicator]:h-full 
                  [&::-webkit-calendar-picker-indicator]:cursor-pointer"
              />
            </div>

            {(scheduleDateTime || (campaign as any)?.scheduled_at) && (
              <div className="flex items-center border-l border-border pl-2 ml-1 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs font-semibold text-emerald-700 hover:text-emerald-800 hover:bg-emerald-100/50"
                  disabled={campaign?.status === "running" || saveCampaignSchedule.isPending}
                  onClick={() => scheduleDateTime && saveCampaignSchedule.mutate(scheduleDateTime)}
                >
                  Save
                </Button>
                {(campaign as any)?.scheduled_at && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs font-semibold text-destructive hover:text-destructive hover:bg-destructive/10"
                    disabled={campaign?.status === "running" || saveCampaignSchedule.isPending}
                    onClick={() => {
                      setScheduleDateTime("");
                      saveCampaignSchedule.mutate(null);
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            )}
          </div>
          <Select value={riskFilter} onValueChange={setRiskFilter}>
            <SelectTrigger className="w-[160px] h-9 text-xs">
              <SelectValue placeholder="Target Risk" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Patients</SelectItem>
              <SelectItem value="High">High Risk Only</SelectItem>
              <SelectItem value="Moderate">Moderate Risk Only</SelectItem>
              <SelectItem value="Low">Low Risk Only</SelectItem>
            </SelectContent>
          </Select>

          {campaign?.status === "running" ? (
            <Button
              variant="destructive"
              onClick={() => pauseCampaign.mutate()}
              disabled={pauseCampaign.isPending}
            >
              <Pause className="h-4 w-4 mr-1.5" />
              {pauseCampaign.isPending ? "Pausing..." : "Pause Campaign"}
            </Button>
          ) : (
            <Button
              onClick={() => startCampaignAutomation.mutate()}
              disabled={startCampaignAutomation.isPending}
              className="bg-emerald-700 text-white hover:bg-emerald-800 transition-colors"
            >
              <Play className="h-4 w-4 mr-1.5 fill-current" />
              {startCampaignAutomation.isPending ? "Starting..." : "Start Campaign"}
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="font-medium">Progress</span>
          <span className="text-muted-foreground">
            {completedCount} / {patients.length} completed
          </span>
        </div>
        <Progress value={pct} className="h-2" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard title="Pending" value={pendingCount} icon={Users} />
        <MetricCard
          title="Active"
          value={activeCount}
          icon={Activity}
          highlight={activeCount > 0}
        />
        <MetricCard title="Completed" value={completedCount} icon={CheckCircle2} />
        <MetricCard title="Success Rate" value={`${successRate}%`} icon={Target} />
      </div>

      <Tabs defaultValue="queue" className="w-full">
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="queue">Live Scheduler ({queueList.length})</TabsTrigger>
            <TabsTrigger value="outcomes">Campaign Outcomes ({outcomesList.length})</TabsTrigger>
          </TabsList>

          {/* --- NEW: Refresh Action Box --- */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => resetStuckCalls.mutate()}
            disabled={campaign?.status === "running" || resetStuckCalls.isPending}
            className="text-muted-foreground hover:text-foreground h-9 w-9"
            title="Reset stuck calls to pending"
          >
            <RefreshCcw className={`h-4 w-4 ${resetStuckCalls.isPending ? "animate-spin" : ""}`} />
            <span className="sr-only">Reset Stuck Calls</span>
          </Button>
        </div>

        <TabsContent value="queue" className="space-y-4">
          <PatientTable data={queueList} />
        </TabsContent>
        <TabsContent value="outcomes" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <Button
              size="sm"
              variant={outcomeFilter === "all" ? "default" : "outline"}
              onClick={() => setOutcomeFilter("all")}
            >
              All Outcomes
            </Button>

            {dynamicOutcomes.map((outcome) => {
              const label = outcome.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

              return (
                <Button
                  key={outcome}
                  size="sm"
                  variant={outcomeFilter === outcome ? "default" : "outline"}
                  onClick={() => setOutcomeFilter(outcome)}
                >
                  {label}
                </Button>
              );
            })}
          </div>
          <PatientTable data={filteredOutcomes} />
        </TabsContent>
      </Tabs>

      {callPatient && (
        <LiveCallMonitor
          patient={callPatient}
          campaignId={campaignId}
          onClose={() => {
            setCallPatient(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
