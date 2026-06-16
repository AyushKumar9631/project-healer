import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Pencil, Stethoscope, Video, Upload, Download, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { parseDoctorCsv, type ParsedDoctor } from "@/lib/doctorCsv";

interface Doctor {
  id: string;
  name: string;
  specialization: string | null;
  super_specialization: string | null;
  qualifications: string | null;
  experience_years: number | null;
  conditions: string[];
  languages: string[];
  availability: string | null;
  consultation_fee: number | null;
  patients_treated: number | null;
  online_consultation: boolean | null;
}

export function DoctorsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Doctor | null>(null);
  const [search, setSearch] = useState("");

  const { data: doctors = [] } = useQuery({
    queryKey: ["doctors"],
    queryFn: async () => {
      const { data, error } = await supabase.from("doctors").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data as Doctor[];
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("doctors").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["doctors"] });
      toast.success("Doctor removed");
    },
  });

  const filtered = doctors.filter((d) => {
    const q = search.toLowerCase();
    return (
      !q ||
      d.name.toLowerCase().includes(q) ||
      d.specialization?.toLowerCase().includes(q) ||
      d.conditions.some((c) => c.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Input
          placeholder="Search by name, specialization, or condition…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <a href="/samples/doctors_sample.csv" download>
              <Download className="h-4 w-4 mr-1.5" /> Sample CSV
            </a>
          </Button>
          <BulkImportDoctorsDialog />
          <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
            <DialogTrigger asChild>
              <Button onClick={() => setEditing(null)}>
                <Plus className="h-4 w-4 mr-1.5" /> Add doctor
              </Button>
            </DialogTrigger>
            <DoctorDialog key={editing?.id ?? "new"} editing={editing} onClose={() => setOpen(false)} />
          </Dialog>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <Stethoscope className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-medium">No doctors yet</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Add your specialists so the AI can recommend them
          </p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((d) => (
            <div key={d.id} className="rounded-xl border bg-card p-5">
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <h3 className="font-semibold">{d.name}</h3>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm text-muted-foreground">{d.specialization}</p>
                    {d.online_consultation && (
                      <Badge variant="outline" className="text-[10px] gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                        <Video className="h-3 w-3" /> Online
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button variant="ghost" size="icon" onClick={() => { setEditing(d); setOpen(true); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => del.mutate(d.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {d.super_specialization && (
                <p className="text-xs text-muted-foreground mt-1">{d.super_specialization}</p>
              )}
              <div className="mt-3 text-xs text-muted-foreground space-y-1">
                {d.qualifications && <div>{d.qualifications}</div>}
                {d.experience_years ? <div>{d.experience_years} yrs experience</div> : null}
                {d.consultation_fee != null && <div>₹{d.consultation_fee} consultation fee</div>}
                {d.patients_treated != null && <div>{d.patients_treated.toLocaleString()}+ patients treated</div>}
              </div>
              {d.conditions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {d.conditions.slice(0, 6).map((c) => (
                    <Badge key={c} variant="secondary" className="text-xs">{c}</Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DoctorDialog({ editing, onClose }: { editing: Doctor | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: editing?.name ?? "",
    specialization: editing?.specialization ?? "",
    super_specialization: editing?.super_specialization ?? "",
    qualifications: editing?.qualifications ?? "",
    experience_years: editing?.experience_years ?? 0,
    conditions: editing?.conditions.join(", ") ?? "",
    languages: editing?.languages.join(", ") ?? "Hindi, English",
    availability: editing?.availability ?? "",
    consultation_fee: editing?.consultation_fee ?? ("" as number | ""),
    patients_treated: editing?.patients_treated ?? ("" as number | ""),
    online_consultation: editing?.online_consultation ?? false,
  });

  const save = useMutation({
    mutationFn: async () => {
      const { data: clinicRow } = await supabase.from("clinics").select("id").maybeSingle();
      if (!clinicRow) throw new Error("No clinic found");
      const payload = {
        clinic_id: clinicRow.id,
        name: form.name,
        specialization: form.specialization || null,
        super_specialization: form.super_specialization || null,
        qualifications: form.qualifications || null,
        experience_years: Number(form.experience_years) || 0,
        conditions: form.conditions.split(",").map((s) => s.trim()).filter(Boolean),
        languages: form.languages.split(",").map((s) => s.trim()).filter(Boolean),
        availability: form.availability || null,
        consultation_fee: form.consultation_fee === "" ? null : Number(form.consultation_fee),
        patients_treated: form.patients_treated === "" ? null : Number(form.patients_treated),
        online_consultation: !!form.online_consultation,
      };
      if (editing) {
        const { error } = await supabase.from("doctors").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("doctors").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["doctors"] });
      toast.success(editing ? "Doctor updated" : "Doctor added");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit doctor" : "Add doctor"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label>Name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Specialization</Label>
            <Input value={form.specialization} onChange={(e) => setForm({ ...form, specialization: e.target.value })} placeholder="Cardiology" />
          </div>
          <div>
            <Label>Super specialization</Label>
            <Input value={form.super_specialization} onChange={(e) => setForm({ ...form, super_specialization: e.target.value })} placeholder="Interventional" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Qualifications</Label>
            <Input value={form.qualifications} onChange={(e) => setForm({ ...form, qualifications: e.target.value })} placeholder="MBBS, MD" />
          </div>
          <div>
            <Label>Experience (yrs)</Label>
            <Input type="number" value={form.experience_years} onChange={(e) => setForm({ ...form, experience_years: Number(e.target.value) })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Consultation fee (₹)</Label>
            <Input
              type="number"
              min={0}
              value={form.consultation_fee}
              onChange={(e) => setForm({ ...form, consultation_fee: e.target.value === "" ? "" : Number(e.target.value) })}
              placeholder="500"
            />
          </div>
          <div>
            <Label>Patients treated</Label>
            <Input
              type="number"
              min={0}
              value={form.patients_treated}
              onChange={(e) => setForm({ ...form, patients_treated: e.target.value === "" ? "" : Number(e.target.value) })}
              placeholder="5000"
            />
          </div>
        </div>
        <div>
          <Label>Conditions treated (comma-separated)</Label>
          <Textarea value={form.conditions} onChange={(e) => setForm({ ...form, conditions: e.target.value })} placeholder="hypertension, chest pain, diabetes" rows={2} />
        </div>
        <div>
          <Label>Languages (comma-separated)</Label>
          <Input value={form.languages} onChange={(e) => setForm({ ...form, languages: e.target.value })} />
        </div>
        <div>
          <Label>Availability</Label>
          <Input value={form.availability} onChange={(e) => setForm({ ...form, availability: e.target.value })} placeholder="Mon-Fri, 10 AM - 4 PM" />
        </div>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label className="text-sm">Online consultation</Label>
            <p className="text-xs text-muted-foreground mt-0.5">Doctor offers video / tele-consultation</p>
          </div>
          <Switch
            checked={!!form.online_consultation}
            onCheckedChange={(v) => setForm({ ...form, online_consultation: v })}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={!form.name || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function BulkImportDoctorsDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ParsedDoctor[]>([]);
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);

  const reset = () => { setRows([]); setFileName(""); };

  const handleFile = async (file: File) => {
    setParsing(true);
    try {
      const parsed = await parseDoctorCsv(file);
      setRows(parsed);
      setFileName(file.name);
      if (parsed.length === 0) toast.error("No rows found in CSV");
    } catch (e) {
      toast.error((e as Error).message || "Failed to parse CSV");
    } finally {
      setParsing(false);
    }
  };

  const importMut = useMutation({
    mutationFn: async () => {
      const valid = rows.filter((r) => r._errors.length === 0);
      if (valid.length === 0) throw new Error("No valid rows to import");
      const { data: clinicRow } = await supabase.from("clinics").select("id").maybeSingle();
      if (!clinicRow) throw new Error("No clinic found");
      const payload = valid.map((r) => ({
        clinic_id: clinicRow.id,
        name: r.name,
        specialization: r.specialization,
        super_specialization: r.super_specialization,
        qualifications: r.qualifications,
        experience_years: r.experience_years,
        conditions: r.conditions,
        languages: r.languages,
        availability: r.availability,
        consultation_fee: r.consultation_fee,
        patients_treated: r.patients_treated,
        online_consultation: r.online_consultation,
      }));
      const { error } = await supabase.from("doctors").insert(payload);
      if (error) throw error;
      return { imported: valid.length, skipped: rows.length - valid.length };
    },
    onSuccess: ({ imported, skipped }) => {
      qc.invalidateQueries({ queryKey: ["doctors"] });
      toast.success(
        skipped > 0
          ? `Imported ${imported} doctors. ${skipped} row${skipped > 1 ? "s" : ""} skipped.`
          : `Imported ${imported} doctors.`
      );
      reset();
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const validCount = rows.filter((r) => r._errors.length === 0).length;
  const invalidCount = rows.length - validCount;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="h-4 w-4 mr-1.5" /> Bulk import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bulk import doctors</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border border-dashed p-6 text-center">
            <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground mb-3">
              Upload a CSV file. Need the format?{" "}
              <a href="/samples/doctors_sample.csv" download className="text-primary underline">
                Download sample
              </a>
            </p>
            <Input
              type="file"
              accept=".csv,text/csv"
              className="max-w-sm mx-auto"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            {fileName && (
              <p className="text-xs text-muted-foreground mt-2">Loaded: {fileName}</p>
            )}
          </div>

          {parsing && <p className="text-sm text-muted-foreground">Parsing…</p>}

          {rows.length > 0 && (
            <>
              <div className="flex items-center gap-3 text-sm">
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400 gap-1">
                  <CheckCircle2 className="h-3 w-3" /> {validCount} valid
                </Badge>
                {invalidCount > 0 && (
                  <Badge variant="outline" className="border-destructive/40 text-destructive gap-1">
                    <AlertCircle className="h-3 w-3" /> {invalidCount} invalid
                  </Badge>
                )}
                <span className="text-muted-foreground">{rows.length} total</span>
              </div>

              <div className="max-h-[40vh] overflow-y-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs">
                    <tr>
                      <th className="text-left p-2 w-8"></th>
                      <th className="text-left p-2">Name</th>
                      <th className="text-left p-2">Specialization</th>
                      <th className="text-left p-2">Fee</th>
                      <th className="text-left p-2">Online</th>
                      <th className="text-left p-2">Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r._rowIndex} className="border-t">
                        <td className="p-2">
                          {r._errors.length === 0 ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                          ) : (
                            <AlertCircle className="h-4 w-4 text-destructive" />
                          )}
                        </td>
                        <td className="p-2">{r.name || <span className="text-muted-foreground italic">—</span>}</td>
                        <td className="p-2">{r.specialization || <span className="text-muted-foreground">—</span>}</td>
                        <td className="p-2">{r.consultation_fee != null ? `₹${r.consultation_fee}` : <span className="text-muted-foreground">—</span>}</td>
                        <td className="p-2">{r.online_consultation ? "Yes" : "No"}</td>
                        <td className="p-2 text-destructive text-xs">{r._errors.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); setOpen(false); }}>Cancel</Button>
          <Button
            onClick={() => importMut.mutate()}
            disabled={validCount === 0 || importMut.isPending}
          >
            {importMut.isPending ? "Importing…" : `Import ${validCount} doctor${validCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
