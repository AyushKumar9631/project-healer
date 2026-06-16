import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

interface Clinic {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  created_at: string;
}

interface Profile {
  clinic_id: string;
  about: string | null;
  address: string | null;
  timings: string | null;
  emergency_phone: string | null;
  departments: string[];
  accreditations: string[];
  extra_notes: string | null;
}

export function ClinicProfileTab() {
  const qc = useQueryClient();

  const { data: clinic } = useQuery({
    queryKey: ["my-clinic"],
    queryFn: async () => {
      const { data } = await supabase
        .from("clinics")
        .select("id,name,email,phone,created_at")
        .maybeSingle();
      return data as Clinic | null;
    },
  });

  const { data: profile } = useQuery({
    queryKey: ["clinic-profile", clinic?.id],
    enabled: !!clinic?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("clinic_profile")
        .select("*")
        .eq("clinic_id", clinic!.id)
        .maybeSingle();
      return data as Profile | null;
    },
  });

  const [reg, setReg] = useState({ name: "", phone: "" });
  const [form, setForm] = useState({
    about: "",
    address: "",
    timings: "",
    emergency_phone: "",
    departments: "",
    accreditations: "",
    extra_notes: "",
  });

  useEffect(() => {
    if (clinic) setReg({ name: clinic.name ?? "", phone: clinic.phone ?? "" });
  }, [clinic]);

  useEffect(() => {
    if (profile) {
      setForm({
        about: profile.about ?? "",
        address: profile.address ?? "",
        timings: profile.timings ?? "",
        emergency_phone: profile.emergency_phone ?? "",
        departments: profile.departments?.join(", ") ?? "",
        accreditations: profile.accreditations?.join(", ") ?? "",
        extra_notes: profile.extra_notes ?? "",
      });
    } else if (clinic && !profile) {
      // Prefill emergency phone from clinic phone on first visit
      setForm((f) => ({ ...f, emergency_phone: f.emergency_phone || clinic.phone || "" }));
    }
  }, [profile, clinic]);

  const save = useMutation({
    mutationFn: async () => {
      if (!clinic?.id) throw new Error("No clinic");
      const name = reg.name.trim();
      if (!name) throw new Error("Clinic name is required");
      if (reg.phone && reg.phone.length > 20) throw new Error("Phone must be 20 chars or fewer");

      const profilePayload = {
        clinic_id: clinic.id,
        about: form.about || null,
        address: form.address || null,
        timings: form.timings || null,
        emergency_phone: form.emergency_phone || null,
        departments: form.departments.split(",").map((s) => s.trim()).filter(Boolean),
        accreditations: form.accreditations.split(",").map((s) => s.trim()).filter(Boolean),
        extra_notes: form.extra_notes || null,
      };

      const [clinicRes, profileRes] = await Promise.all([
        supabase.from("clinics").update({ name, phone: reg.phone || null }).eq("id", clinic.id),
        supabase.from("clinic_profile").upsert(profilePayload, { onConflict: "clinic_id" }),
      ]);
      if (clinicRes.error) throw clinicRes.error;
      if (profileRes.error) throw profileRes.error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-clinic"] });
      qc.invalidateQueries({ queryKey: ["my-clinic-id"] });
      qc.invalidateQueries({ queryKey: ["clinic-profile"] });
      toast.success("Clinic profile saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="max-w-3xl space-y-8">
      {/* Section A — Registered details */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Registered details</h2>
          <p className="text-sm text-muted-foreground">
            This is what your clinic is registered as — keep it accurate.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <Label>Clinic / Hospital name *</Label>
            <Input
              value={reg.name}
              onChange={(e) => setReg({ ...reg, name: e.target.value })}
              placeholder="e.g. Sunrise Multispeciality Hospital"
              maxLength={120}
            />
          </div>
          <div>
            <Label>Primary phone</Label>
            <Input
              value={reg.phone}
              onChange={(e) => setReg({ ...reg, phone: e.target.value })}
              placeholder="+91 ..."
              maxLength={20}
            />
          </div>
        </div>
        <div>
          <Label>Contact email</Label>
          <Input value={clinic?.email ?? ""} disabled />
          <p className="text-xs text-muted-foreground mt-1">
            This is your account email. Change it from account settings.
          </p>
        </div>
        {clinic?.created_at && (
          <p className="text-xs text-muted-foreground">
            Registered on {new Date(clinic.created_at).toLocaleDateString()}
          </p>
        )}
      </section>

      <div className="border-t" />

      {/* Section B — Public profile & AI knowledge */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Public profile & AI knowledge</h2>
          <p className="text-sm text-muted-foreground">
            Used by the AI agent to describe your clinic on patient calls.
          </p>
        </div>

        <div>
          <Label>About the clinic / hospital</Label>
          <Textarea
            rows={4}
            value={form.about}
            onChange={(e) => setForm({ ...form, about: e.target.value })}
            placeholder="A brief introduction the AI agent can use to describe your clinic to patients."
          />
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <Label>Address</Label>
            <Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          <div>
            <Label>Timings</Label>
            <Textarea rows={2} value={form.timings} onChange={(e) => setForm({ ...form, timings: e.target.value })} placeholder="Mon–Sat 9 AM – 8 PM, Sun closed" />
          </div>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <Label>Emergency phone</Label>
            <Input value={form.emergency_phone} onChange={(e) => setForm({ ...form, emergency_phone: e.target.value })} placeholder="+91 ..." />
          </div>
          <div>
            <Label>Departments (comma-separated)</Label>
            <Input value={form.departments} onChange={(e) => setForm({ ...form, departments: e.target.value })} placeholder="Cardiology, Diabetology, Radiology" />
          </div>
        </div>
        <div>
          <Label>Accreditations (comma-separated)</Label>
          <Input value={form.accreditations} onChange={(e) => setForm({ ...form, accreditations: e.target.value })} placeholder="NABH, ISO 9001" />
        </div>
        <div>
          <Label>Extra notes for the AI agent</Label>
          <Textarea
            rows={3}
            value={form.extra_notes}
            onChange={(e) => setForm({ ...form, extra_notes: e.target.value })}
            placeholder="Parking, transport, language support, anything else worth mentioning."
          />
        </div>
      </section>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !clinic?.id}>
          {save.isPending ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </div>
  );
}
