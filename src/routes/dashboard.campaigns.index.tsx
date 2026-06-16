import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Megaphone, Plus, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/campaigns/")({ component: Campaigns });

function Campaigns() {
  const [open, setOpen] = useState(false);

  const { data: campaigns = [] } = useQuery({
    queryKey: ["campaigns"],
    refetchInterval: 2000, // Poll for total patient updates
    queryFn: async () => {
      const { data, error } = await supabase
        .from("campaigns")
        .select("*, patient_lists(name)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  // NEW: Fetch all calls globally to calculate real-time completion status
  const { data: calls = [] } = useQuery({
    queryKey: ["global-campaign-calls"],
    refetchInterval: 2000,
    queryFn: async () => {
      const { data, error } = await supabase.from("calls").select("campaign_id, status");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Calculate the exact number of completed calls per campaign
  // Calculate the exact number of completed calls per campaign
  const completionsByCampaign = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const call of calls) {
      // Add the call.campaign_id check right here!
      if (call.status === "completed" && call.campaign_id) {
        counts[call.campaign_id] = (counts[call.campaign_id] || 0) + 1;
      }
    }
    return counts;
  }, [calls]);
  return (
    <div className="p-8 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Open a campaign to start real outbound calls to patients via Twilio.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-1.5" /> New campaign
            </Button>
          </DialogTrigger>
          <NewCampaignDialog onClose={() => setOpen(false)} />
        </Dialog>
      </div>

      {campaigns.length === 0 ? (
        <div className="rounded-xl border bg-card p-16 text-center shadow-sm">
          <Megaphone className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
          <h3 className="font-semibold text-lg">No campaigns yet</h3>
          <p className="text-sm text-muted-foreground mt-1">Create one to start calling patients</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {campaigns.map((c) => {
            // NEW: Use the real-time calculated completion count
            const realCompleted = completionsByCampaign[c.id] || 0;
            const pct = c.total_patients > 0 ? (realCompleted / c.total_patients) * 100 : 0;

            // Dynamic Status Label based on actual progress
            let displayStatus = "Draft";
            if (realCompleted > 0 && realCompleted < c.total_patients) displayStatus = "Active";
            if (realCompleted === c.total_patients && c.total_patients > 0)
              displayStatus = "Completed";

            return (
              <div
                key={c.id}
                className="relative rounded-xl border bg-card p-6 hover:border-primary/50 hover:shadow-md transition-all group"
              >
                <Link
                  to="/dashboard/campaigns/$campaignId"
                  params={{ campaignId: c.id }}
                  className="block"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="pr-10">
                      <h3 className="font-semibold text-lg line-clamp-1">{c.name}</h3>
                      <p className="text-xs text-muted-foreground mt-1 flex flex-col gap-0.5">
                        <span className="font-medium text-foreground/80">
                          {(c as { patient_lists?: { name: string } }).patient_lists?.name}
                        </span>
                        <span className="uppercase tracking-wider opacity-70 text-[10px]">
                          {c.use_case.replace(/_/g, " ")}
                        </span>
                      </p>
                    </div>
                    <Badge
                      variant={
                        displayStatus === "Completed"
                          ? "default"
                          : displayStatus === "Active"
                            ? "secondary"
                            : "outline"
                      }
                      className={
                        displayStatus === "Active"
                          ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border-transparent"
                          : ""
                      }
                    >
                      {displayStatus}
                    </Badge>
                  </div>
                  <div className="mt-6">
                    <div className="flex justify-between text-xs font-medium mb-2">
                      <span className="text-muted-foreground">Progress</span>
                      <span>
                        {realCompleted} / {c.total_patients} calls
                      </span>
                    </div>
                    <Progress value={pct} className="h-2" />
                  </div>
                </Link>
                <DeleteCampaignButton campaignId={c.id} campaignName={c.name} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DeleteCampaignButton({
  campaignId,
  campaignName,
}: {
  campaignId: string;
  campaignName: string;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async () => {
      const { data: callRows, error: callsFetchErr } = await supabase
        .from("calls")
        .select("id")
        .eq("campaign_id", campaignId);
      if (callsFetchErr) throw callsFetchErr;
      const callIds = (callRows ?? []).map((c) => c.id);
      if (callIds.length) {
        const { error: evErr } = await supabase.from("call_events").delete().in("call_id", callIds);
        if (evErr) throw evErr;
        const { error: cErr } = await supabase.from("calls").delete().in("id", callIds);
        if (cErr) throw cErr;
      }
      const { error } = await supabase.from("campaigns").delete().eq("id", campaignId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success("Campaign deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="absolute top-4 right-4 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={(e) => e.stopPropagation()}
          aria-label="Delete campaign"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{campaignName}"?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the campaign and all its calls. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => del.mutate()}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type UseCase =
  | "screening_to_opd"
  | "free_screening_invite"
  | "free_screening_invite_existing"
  | "newborn_vaccination";

const USE_CASE_OPTIONS: { value: UseCase; label: string; hint: string }[] = [
  {
    value: "screening_to_opd",
    label: "Screening → OPD conversion",
    hint: "Default: post-screening follow-up.",
  },
  {
    value: "free_screening_invite",
    label: "Free Screening Invite (RSVP)",
    hint: "Invite patients to a free camp.",
  },
  {
    value: "free_screening_invite_existing",
    label: "Free Screening Invite (RSVP) — Existing Patient",
    hint: "Uses the patient's past BP / Glucose vitals to open the call, then invites to a new camp.",
  },
  {
    value: "newborn_vaccination",
    label: "New-Born Vaccination Reminder",
    hint: "Requires babies on file for each patient.",
  },
];

function NewCampaignDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [listId, setListId] = useState<string>("");
  const [useCase, setUseCase] = useState<UseCase>("screening_to_opd");
  // Free-screening config
  const [campName, setCampName] = useState("");
  const [campDate, setCampDate] = useState(""); // ISO date, e.g. 2026-05-15
  const [campTime, setCampTime] = useState("09:00");
  const [slotWindow, setSlotWindow] = useState("9 AM – 1 PM");
  const [venue, setVenue] = useState("");
  const [address, setAddress] = useState("");
  const [freeTests, setFreeTests] = useState("BP, Blood Sugar");

  const { data: lists = [] } = useQuery({
    queryKey: ["patient_lists"],
    queryFn: async () => {
      const { data } = await supabase
        .from("patient_lists")
        .select("*")
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { data: clinicRow } = await supabase.from("clinics").select("id").maybeSingle();
      if (!clinicRow) throw new Error("No clinic");
      const list = lists.find((l) => l.id === listId);
      const { data: campaign, error } = await supabase
        .from("campaigns")
        .insert({
          clinic_id: clinicRow.id,
          patient_list_id: listId,
          name,
          use_case: useCase,
          status: "draft",
          total_patients: list?.patient_count ?? 0,
        })
        .select("id")
        .single();
      if (error) throw error;

      // Persist playbook config when applicable.
      const isCampUseCase =
        useCase === "free_screening_invite" || useCase === "free_screening_invite_existing";
      if (isCampUseCase && campaign) {
        const isoDateTime = campDate
          ? new Date(`${campDate}T${campTime}:00+05:30`).toISOString()
          : null;
        const config_json = {
          camp_name: campName || null,
          camp_date_iso: isoDateTime,
          slot_window: slotWindow || null,
          venue: venue || null,
          address: address || null,
          free_tests: freeTests
            ? freeTests
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        };
        await supabase.from("campaign_playbook_config").insert({
          campaign_id: campaign.id,
          clinic_id: clinicRow.id,
          playbook_key: useCase,
          config_json,
        });
      } else if (useCase === "newborn_vaccination" && campaign) {
        await supabase.from("campaign_playbook_config").insert({
          campaign_id: campaign.id,
          clinic_id: clinicRow.id,
          playbook_key: useCase,
          config_json: {},
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success("Campaign created");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>New campaign</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
        <div>
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="May Free Screening Camp"
            className="mt-1"
          />
        </div>
        <div>
          <Label>Use-case</Label>
          <Select value={useCase} onValueChange={(v) => setUseCase(v as UseCase)}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USE_CASE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1.5">
            {USE_CASE_OPTIONS.find((o) => o.value === useCase)?.hint}
          </p>
        </div>
        <div>
          <Label>Patient list</Label>
          <Select value={listId} onValueChange={setListId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Choose a list" />
            </SelectTrigger>
            <SelectContent>
              {lists.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name} ({l.patient_count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {(useCase === "free_screening_invite" || useCase === "free_screening_invite_existing") && (
          <div className="space-y-4 rounded-xl border p-4 bg-muted/20 mt-2">
            <p className="text-sm font-semibold border-b pb-2">Free screening camp details</p>
            {useCase === "free_screening_invite_existing" && (
              <p className="text-xs text-muted-foreground bg-background border p-2 rounded-md">
                This list should contain patients who already have BP / Blood Glucose vitals on
                file. Patients without prior vitals will fall back to a generic line.
              </p>
            )}
            <div>
              <Label>Camp name (optional)</Label>
              <Input
                value={campName}
                onChange={(e) => setCampName(e.target.value)}
                placeholder="May Wellness Camp"
                className="mt-1"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={campDate}
                  onChange={(e) => setCampDate(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Start time (IST)</Label>
                <Input
                  type="time"
                  value={campTime}
                  onChange={(e) => setCampTime(e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label>Slot window (spoken)</Label>
              <Input
                value={slotWindow}
                onChange={(e) => setSlotWindow(e.target.value)}
                placeholder="9 AM – 1 PM"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Venue</Label>
              <Input
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                placeholder="Clinic main hall, MG Road"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Address (spoken; optional)</Label>
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Sector 22, Gurugram"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Free tests (comma separated)</Label>
              <Input
                value={freeTests}
                onChange={(e) => setFreeTests(e.target.value)}
                placeholder="BP, Blood Sugar"
                className="mt-1"
              />
            </div>
          </div>
        )}

        {useCase === "newborn_vaccination" && (
          <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-900 dark:text-amber-200 mt-2 border border-amber-200 dark:border-amber-900/50">
            Each patient in this list must have a baby on file (DOB required). Add babies from the
            patient detail page; the IAP schedule (0–9m) is seeded automatically.
          </div>
        )}

        <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground mt-4">
          Calls are placed via Twilio to each patient's phone number. Make sure numbers are E.164
          (e.g. +9198…).
        </div>
      </div>
      <DialogFooter className="pt-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => create.mutate()} disabled={!name || !listId || create.isPending}>
          {create.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Create Campaign
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
