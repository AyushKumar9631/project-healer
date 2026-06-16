import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  Upload,
  Users,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Download,
  Trash2,
} from "lucide-react";
import { parseCsv, type ParsedPatient } from "@/lib/csv";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/patients/")({ component: Patients });

function Patients() {
  const [open, setOpen] = useState(false);

  const { data: lists = [] } = useQuery({
    queryKey: ["patient_lists"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("patient_lists")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Patient Lists</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload screened patients from your health camps
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Users className="h-4 w-4 mr-1.5" /> Import Patients
            </Button>
          </DialogTrigger>
          <ImportDialog onClose={() => setOpen(false)} />{" "}
        </Dialog>
      </div>

      {lists.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <FileSpreadsheet className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-medium">No patient lists yet</h3>
          <p className="text-sm text-muted-foreground mt-1">Upload a CSV to get started</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {lists.map((l) => (
            <div
              key={l.id}
              className="relative rounded-xl border bg-card p-5 hover:border-primary transition-colors group"
            >
              <Link to="/dashboard/patients/$listId" params={{ listId: l.id }} className="block">
                <div className="flex items-start justify-between">
                  <div className="pr-8">
                    <h3 className="font-semibold">{l.name}</h3>
                    {l.source && <p className="text-xs text-muted-foreground mt-0.5">{l.source}</p>}
                  </div>
                  <Users className="h-5 w-5 text-primary" />
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <Badge variant="secondary">{l.patient_count} patients</Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(l.created_at).toLocaleDateString()}
                  </span>
                </div>
              </Link>
              <DeleteListButton listId={l.id} listName={l.name} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DeleteListButton({ listId, listName }: { listId: string; listName: string }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async () => {
      const { error: pErr } = await supabase
        .from("patients")
        .delete()
        .eq("patient_list_id", listId);
      if (pErr) throw pErr;
      const { error } = await supabase.from("patient_lists").delete().eq("id", listId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient_lists"] });
      toast.success("Patient list deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="absolute top-3 right-3 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
          onClick={(e) => e.stopPropagation()}
          aria-label="Delete list"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{listName}"?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the list and all its patients. This cannot be undone.
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

function ImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [method, setMethod] = useState<"csv" | "hmis">("csv");

  // Shared State
  const [name, setName] = useState("");
  const [source, setSource] = useState("");

  // CSV State
  const [parsed, setParsed] = useState<ParsedPatient[]>([]);
  const [parsing, setParsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // HMIS State
  const [adapter, setAdapter] = useState("supabase");
  const [connectionString, setConnectionString] = useState("");
  const [tableName, setTableName] = useState("");

  const valid = parsed.filter((p) => p._errors.length === 0);
  const invalid = parsed.filter((p) => p._errors.length > 0);

  // --- CSV Handlers ---
  const handleFile = async (f: File) => {
    setParsing(true);
    try {
      const rows = await parseCsv(f);
      setParsed(rows);
      if (!name) setName(f.name.replace(/\.csv$/i, ""));
    } catch (e) {
      toast.error("Could not parse CSV");
    } finally {
      setParsing(false);
    }
  };

  const commitCsv = useMutation({
    mutationFn: async () => {
      const { data: clinicRow } = await supabase.from("clinics").select("id").maybeSingle();
      if (!clinicRow) throw new Error("No clinic");
      const { data: list, error: listErr } = await supabase
        .from("patient_lists")
        .insert({
          clinic_id: clinicRow.id,
          name,
          source: source || null,
          patient_count: valid.length,
        })
        .select()
        .single();
      if (listErr) throw listErr;
      const rows = valid.map((p) => ({
        clinic_id: clinicRow.id,
        patient_list_id: list.id,
        name: p.name,
        phone: p.phone,
        age: p.age,
        gender: p.gender,
        health_camp: p.health_camp,
        bp: p.bp,
        blood_sugar: p.blood_sugar,
        risk: p.risk,
      }));
      if (rows.length) {
        const { error } = await supabase.from("patients").insert(rows);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient_lists"] });
      toast.success(`Imported ${valid.length} patients via CSV`);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // --- HMIS Handlers ---
  const syncHmis = useMutation({
    mutationFn: async () => {
      const { data: clinicRow } = await supabase.from("clinics").select("id").maybeSingle();
      if (!clinicRow) throw new Error("No clinic found");

      const response = await fetch("/api/hmis/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinicId: clinicRow.id,
          adapterType: adapter,
          connectionString: connectionString,
          listName: name,
          tableName: tableName || undefined,
        }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "HMIS Sync failed");
      }
      return response.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["patient_lists"] });
      toast.success(`Successfully synced ${data.count} patients from HMIS`);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Import Patients</DialogTitle>
      </DialogHeader>

      <div className="flex gap-2 mb-2">
        <Button
          variant={method === "csv" ? "default" : "outline"}
          className="flex-1"
          onClick={() => setMethod("csv")}
        >
          Upload CSV
        </Button>
        <Button
          variant={method === "hmis" ? "default" : "outline"}
          className="flex-1"
          onClick={() => setMethod("hmis")}
        >
          Sync from HMIS
        </Button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>List name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={method === "csv" ? "Diwali health camp" : "Supabase Live Sync"}
            />
          </div>
          <div>
            <Label>Source (optional)</Label>
            <Input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={method === "csv" ? "Camp at Andheri" : "External Hospital DB"}
            />
          </div>
        </div>

        {method === "csv" ? (
          // --- CSV UI ---
          <>
            <SampleFormatPanel />
            <div
              onClick={() => inputRef.current?.click()}
              className="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer hover:border-primary transition-colors"
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) handleFile(f);
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm">{parsing ? "Parsing…" : "Drop CSV here or click to upload"}</p>
              <p className="text-xs text-muted-foreground mt-1">Required columns: name, phone</p>
              <input
                ref={inputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
            </div>

            {parsed.length > 0 && (
              <>
                <div className="flex gap-2">
                  <Badge className="bg-success text-primary-foreground">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    {valid.length} valid
                  </Badge>
                  {invalid.length > 0 && (
                    <Badge variant="destructive">
                      <AlertCircle className="h-3 w-3 mr-1" />
                      {invalid.length} with errors
                    </Badge>
                  )}
                </div>
                <div className="border rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted text-xs">
                      <tr>
                        <th className="text-left p-2">Row</th>
                        <th className="text-left p-2">Name</th>
                        <th className="text-left p-2">Phone</th>
                        <th className="text-left p-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.slice(0, 50).map((p) => (
                        <tr key={p._rowIndex} className="border-t">
                          <td className="p-2 text-muted-foreground">{p._rowIndex}</td>
                          <td className="p-2">{p.name || "—"}</td>
                          <td className="p-2 font-mono text-xs">{p.phone || "—"}</td>
                          <td className="p-2">
                            {p._errors.length === 0 ? (
                              <span className="text-success">OK</span>
                            ) : (
                              <span className="text-destructive text-xs">
                                {p._errors.join(", ")}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        ) : (
          // --- HMIS UI ---
          <div className="space-y-4 border rounded-xl p-4 bg-muted/20">
            <div>
              <Label>Database Type</Label>
              <select
                value={adapter}
                onChange={(e) => setAdapter(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring mt-1"
              >
                <option value="supabase">Supabase / REST</option>
                <option value="mysql">MySQL (On-Premise)</option>
                <option value="postgres">PostgreSQL (Cloud)</option>
              </select>
            </div>

            <div>
              <Label>Connection String</Label>
              <Input
                value={connectionString}
                onChange={(e) => setConnectionString(e.target.value)}
                placeholder={
                  adapter === "supabase"
                    ? "https://xyz.supabase.co|eyJhbGci..."
                    : "postgresql://user:pass@host:5432/db"
                }
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {adapter === "supabase" ? "Format: URL|ANON_KEY" : "Standard DB connection string"}
              </p>
            </div>

            <div>
              <Label>Target Table Name</Label>
              <Input
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                placeholder="patients"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Defaults to 'patients' if left blank.
              </p>
            </div>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {method === "csv" ? (
          <Button
            onClick={() => commitCsv.mutate()}
            disabled={!name || valid.length === 0 || commitCsv.isPending}
          >
            {commitCsv.isPending ? "Importing…" : `Import ${valid.length} patients`}
          </Button>
        ) : (
          <Button
            onClick={() => syncHmis.mutate()}
            disabled={!name || !connectionString || syncHmis.isPending}
          >
            {syncHmis.isPending ? "Syncing with Database…" : "Start HMIS Sync"}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

const SAMPLE_HEADERS = [
  "name",
  "phone",
  "age",
  "gender",
  "health_camp",
  "bp",
  "blood_sugar",
  "risk",
];
const SAMPLE_ROWS = [
  ["Ramesh Kumar", "9876543210", "54", "M", "Andheri Oct '25", "140/90", "180", "high"],
  ["Sunita Devi", "+919812345678", "47", "F", "Andheri Oct '25", "120/80", "110", "medium"],
];

function downloadSample() {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = [SAMPLE_HEADERS, ...SAMPLE_ROWS].map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sample-patients.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function SampleFormatPanel() {
  return (
    <div className="bg-muted/50 rounded-lg p-3 text-xs space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-sm">Expected CSV format</div>
        <Button type="button" size="sm" variant="outline" onClick={downloadSample}>
          <Download className="h-3.5 w-3.5 mr-1.5" /> Download sample CSV
        </Button>
      </div>
      <div className="border rounded-md overflow-x-auto bg-background">
        <table className="w-full text-xs">
          <thead className="bg-muted">
            <tr>
              {SAMPLE_HEADERS.map((h) => (
                <th key={h} className="text-left p-1.5 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SAMPLE_ROWS.map((row, i) => (
              <tr key={i} className="border-t">
                {row.map((cell, j) => (
                  <td key={j} className="p-1.5 whitespace-nowrap font-mono">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-0.5 text-muted-foreground">
        <li>
          <span className="font-mono text-foreground">name</span> — required, full name
        </li>
        <li>
          <span className="font-mono text-foreground">phone</span> — required, 10-digit Indian
          mobile or +91 format
        </li>
        <li>
          <span className="font-mono text-foreground">
            age, gender, health_camp, bp, blood_sugar, risk
          </span>{" "}
          — optional
        </li>
      </ul>
      <p className="text-muted-foreground">
        Column names are case-insensitive. Common aliases like{" "}
        <span className="font-mono">mobile</span>, <span className="font-mono">sex</span>,{" "}
        <span className="font-mono">glucose</span> are also recognized.
      </p>
    </div>
  );
}
