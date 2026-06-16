import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, Receipt } from "lucide-react";
import { toast } from "sonner";

interface Service {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  price_min: number | null;
  price_max: number | null;
  currency: string;
  duration_minutes: number | null;
  prep_notes: string | null;
  is_active: boolean;
}

const CATEGORIES = ["consultation", "diagnostic", "procedure", "package", "other"];

function priceLabel(s: Service) {
  const sym = s.currency === "INR" ? "₹" : `${s.currency} `;
  if (s.price_min == null && s.price_max == null) return "Price on request";
  if (s.price_max == null || s.price_min === s.price_max) return `${sym}${s.price_min}`;
  return `${sym}${s.price_min} – ${sym}${s.price_max}`;
}

export function ServicesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState<string>("all");

  const { data: services = [] } = useQuery({
    queryKey: ["kb-services"],
    queryFn: async () => {
      const { data, error } = await supabase.from("kb_services").select("*").order("category").order("name");
      if (error) throw error;
      return data as Service[];
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("kb_services").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb-services"] });
      toast.success("Service removed");
    },
  });

  const filtered = services.filter((s) => {
    if (cat !== "all" && s.category !== cat) return false;
    const q = search.toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2 flex-1 min-w-[280px]">
          <Input placeholder="Search services…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
          <Select value={cat} onValueChange={setCat}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button onClick={() => setEditing(null)}><Plus className="h-4 w-4 mr-1.5" /> Add service</Button>
          </DialogTrigger>
          <ServiceDialog editing={editing} onClose={() => setOpen(false)} />
        </Dialog>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <Receipt className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-medium">No services yet</h3>
          <p className="text-sm text-muted-foreground mt-1">Add services and prices so the AI can quote them on calls.</p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card divide-y">
          {filtered.map((s) => (
            <div key={s.id} className="p-4 flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-medium">{s.name}</h4>
                  {s.category && <Badge variant="secondary" className="text-xs">{s.category}</Badge>}
                  {!s.is_active && <Badge variant="outline" className="text-xs">inactive</Badge>}
                </div>
                {s.description && <p className="text-sm text-muted-foreground mt-1">{s.description}</p>}
                <div className="text-xs text-muted-foreground mt-2 flex gap-3 flex-wrap">
                  <span className="font-medium text-foreground">{priceLabel(s)}</span>
                  {s.duration_minutes && <span>~{s.duration_minutes} min</span>}
                  {s.prep_notes && <span>Prep: {s.prep_notes}</span>}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button variant="ghost" size="icon" onClick={() => { setEditing(s); setOpen(true); }}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => del.mutate(s.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceDialog({ editing, onClose }: { editing: Service | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: editing?.name ?? "",
    category: editing?.category ?? "consultation",
    description: editing?.description ?? "",
    price_min: editing?.price_min?.toString() ?? "",
    price_max: editing?.price_max?.toString() ?? "",
    currency: editing?.currency ?? "INR",
    duration_minutes: editing?.duration_minutes?.toString() ?? "",
    prep_notes: editing?.prep_notes ?? "",
    is_active: editing?.is_active ?? true,
  });

  const save = useMutation({
    mutationFn: async () => {
      const { data: clinicRow } = await supabase.from("clinics").select("id").maybeSingle();
      if (!clinicRow) throw new Error("No clinic");
      const payload = {
        clinic_id: clinicRow.id,
        name: form.name,
        category: form.category || null,
        description: form.description || null,
        price_min: form.price_min ? Number(form.price_min) : null,
        price_max: form.price_max ? Number(form.price_max) : null,
        currency: form.currency || "INR",
        duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
        prep_notes: form.prep_notes || null,
        is_active: form.is_active,
      };
      if (editing) {
        const { error } = await supabase.from("kb_services").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("kb_services").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb-services"] });
      toast.success(editing ? "Service updated" : "Service added");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit service" : "Add service"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label>Name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OPD Consultation" />
        </div>
        <div>
          <Label>Category</Label>
          <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Description</Label>
          <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Price min</Label>
            <Input type="number" value={form.price_min} onChange={(e) => setForm({ ...form, price_min: e.target.value })} />
          </div>
          <div>
            <Label>Price max</Label>
            <Input type="number" value={form.price_max} onChange={(e) => setForm({ ...form, price_max: e.target.value })} placeholder="optional" />
          </div>
          <div>
            <Label>Currency</Label>
            <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Duration (min)</Label>
            <Input type="number" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} />
          </div>
          <div className="flex items-end gap-3 pb-2">
            <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
            <Label className="cursor-pointer">Active (used by AI)</Label>
          </div>
        </div>
        <div>
          <Label>Prep notes</Label>
          <Textarea rows={2} value={form.prep_notes} onChange={(e) => setForm({ ...form, prep_notes: e.target.value })} placeholder="Fasting required, bring previous reports, etc." />
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
