import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ArrowLeft, PhoneCall, Phone, Beaker, Activity, Baby } from "lucide-react";

import { LiveCallMonitor } from "@/components/LiveCallMonitor";
import { computeSeedRows } from "@/lib/vaccinationSchedule.shared";
import { toast } from "sonner";

async function startPlivoCall(patientId: string) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) {
    toast.error("Not signed in");
    return;
  }
  const res = await fetch("/api/calls/start-plivo", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ patientId }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast.error(`Plivo call failed: ${json.error ?? res.statusText}`);
    return;
  }
  toast.success(`Plivo call started (callId ${String(json.callId).slice(0, 8)}…)`);
}

async function testBridge() {
  const t = toast.loading("Probing Railway bridge…");
  try {
    const res = await fetch("/api/calls/bridge-status");
    const j = await res.json().catch(() => ({}));
    toast.dismiss(t);
    if (j.ok) {
      toast.success(
        `Bridge OK · health ${j.health?.latencyMs}ms · Plivo env ready (${j.plivoHealth?.latencyMs}ms)`,
      );
    } else {
      const envObj = (j.plivoHealth?.body as { env?: Record<string, boolean> } | undefined)?.env;
      const missing = envObj
        ? Object.entries(envObj)
            .filter(([, v]) => !v)
            .map(([k]) => k)
        : [];
      const envHint = missing.length ? ` · missing on Railway: ${missing.join(", ")}` : "";
      toast.error(`Bridge FAIL · health=${j.healthOk} plivoHealth=${j.plivoHealthOk}${envHint}`, {
        duration: 12000,
      });
    }
  } catch (e) {
    toast.dismiss(t);
    toast.error(`Bridge probe error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const Route = createFileRoute("/dashboard/patients/$listId")({ component: ListDetail });

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

function ListDetail() {
  const { listId } = Route.useParams();
  const [callPatient, setCallPatient] = useState<Patient | null>(null);
  const [livePatient, setLivePatient] = useState<Patient | null>(null);
  const [babyPatient, setBabyPatient] = useState<Patient | null>(null);

  const { data: list } = useQuery({
    queryKey: ["list", listId],
    queryFn: async () => {
      const { data } = await supabase
        .from("patient_lists")
        .select("*")
        .eq("id", listId)
        .maybeSingle();
      return data;
    },
  });

  const { data: patients = [] } = useQuery({
    queryKey: ["patients", listId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("patients")
        .select("*")
        .eq("patient_list_id", listId)
        .order("created_at");
      if (error) throw error;
      return data as Patient[];
    },
  });

  // Pull baby counts so we can show a tiny badge on each row.
  const { data: babyCounts = {} } = useQuery({
    queryKey: ["babies-count", listId, patients.map((p) => p.id).join(",")],
    enabled: patients.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("babies")
        .select("patient_id")
        .in(
          "patient_id",
          patients.map((p) => p.id),
        );
      const counts: Record<string, number> = {};
      for (const r of data ?? []) counts[r.patient_id] = (counts[r.patient_id] ?? 0) + 1;
      return counts;
    },
  });

  return (
    <div className="p-8 space-y-6">
      <Link
        to="/dashboard/patients"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to lists
      </Link>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{list?.name ?? "List"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {patients.length} patients · Tip: use Campaigns to run calls in batches.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={testBridge}>
          <Activity className="h-3.5 w-3.5 mr-1" /> Test bridge
        </Button>
      </div>

      <div className="border rounded-xl bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs">
            <tr>
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Phone</th>
              <th className="text-left p-3">Age</th>
              <th className="text-left p-3">BP</th>
              <th className="text-left p-3">Sugar</th>
              <th className="text-left p-3">Risk</th>
              <th className="text-left p-3">Baby</th>
              <th className="text-right p-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {patients.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="p-3 font-medium">{p.name}</td>
                <td className="p-3 font-mono text-xs">{p.phone}</td>
                <td className="p-3">{p.age ?? "—"}</td>
                <td className="p-3">{p.bp ?? "—"}</td>
                <td className="p-3">{p.blood_sugar ?? "—"}</td>
                <td className="p-3">
                  {p.risk ? <Badge variant="secondary">{p.risk}</Badge> : "—"}
                </td>
                <td className="p-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={() => setBabyPatient(p)}
                  >
                    <Baby className="h-3.5 w-3.5 mr-1" />
                    {babyCounts[p.id] ?? 0}
                  </Button>
                </td>
                <td className="p-3 text-right space-x-1">
                  <Button size="sm" variant="outline" onClick={() => setCallPatient(p)}>
                    <PhoneCall className="h-3.5 w-3.5 mr-1" /> Test in browser
                  </Button>
                  <Button size="sm" onClick={() => setLivePatient(p)}>
                    <Phone className="h-3.5 w-3.5 mr-1" /> Call patient now
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => startPlivoCall(p.id)}
                    title="Test via Plivo + Sarvam (parallel cost test)"
                  >
                    <Beaker className="h-3.5 w-3.5 mr-1" /> Test via Plivo
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {callPatient && null}
      {livePatient && (
        <LiveCallMonitor patient={livePatient} onClose={() => setLivePatient(null)} />
      )}
      {babyPatient && <BabiesDialog patient={babyPatient} onClose={() => setBabyPatient(null)} />}
    </div>
  );
}

function BabiesDialog({ patient, onClose }: { patient: Patient; onClose: () => void }) {
  const qc = useQueryClient();
  const [babyName, setBabyName] = useState("");
  const [parentName, setParentName] = useState(patient.name ?? "");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");

  const { data: babies = [], refetch } = useQuery({
    queryKey: ["babies", patient.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("babies")
        .select("id,baby_name,parent_name,dob,gender,created_at")
        .eq("patient_id", patient.id)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const add = useMutation({
    mutationFn: async () => {
      if (!babyName || !dob) throw new Error("Baby name and DOB required");
      const { data: clinic } = await supabase.from("clinics").select("id").maybeSingle();
      if (!clinic) throw new Error("No clinic");
      const { data: baby, error } = await supabase
        .from("babies")
        .insert({
          clinic_id: clinic.id,
          patient_id: patient.id,
          baby_name: babyName,
          parent_name: parentName,
          dob,
          gender: gender || null,
        })
        .select("id")
        .single();
      if (error) throw error;
      // Seed IAP doses.
      const rows = computeSeedRows({ clinicId: clinic.id, babyId: baby.id, dob });
      const { error: dErr } = await supabase
        .from("vaccination_doses")
        .upsert(rows, { onConflict: "baby_id,vaccine_code", ignoreDuplicates: true });
      if (dErr) throw dErr;
    },
    onSuccess: () => {
      toast.success("Baby added · vaccination schedule seeded");
      setBabyName("");
      setDob("");
      setGender("");
      refetch();
      qc.invalidateQueries({ queryKey: ["babies-count"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Babies for {patient.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {babies.length > 0 && (
            <div className="space-y-1">
              {babies.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between rounded-md border p-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{b.baby_name}</div>
                    <div className="text-xs text-muted-foreground">
                      DOB {b.dob}
                      {b.gender ? ` · ${b.gender}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2 rounded-md border p-3 bg-muted/30">
            <p className="text-sm font-medium">Add a baby</p>
            <div>
              <Label>Parent name</Label>
              <Input value={parentName} onChange={(e) => setParentName(e.target.value)} />
            </div>
            <div>
              <Label>Baby name</Label>
              <Input
                value={babyName}
                onChange={(e) => setBabyName(e.target.value)}
                placeholder="Aarav"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Date of birth</Label>
                <Input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
              </div>
              <div>
                <Label>Gender (optional)</Label>
                <Input
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  placeholder="M / F"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Adding a baby will seed the IAP 0–9 month vaccination schedule automatically.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => add.mutate()} disabled={!babyName || !dob || add.isPending}>
            {add.isPending ? "Adding…" : "Add baby"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
