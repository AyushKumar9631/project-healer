import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DoctorsTab } from "@/components/kb/DoctorsTab";
import { ClinicProfileTab } from "@/components/kb/ClinicProfileTab";
import { ServicesTab } from "@/components/kb/ServicesTab";
import { FaqsTab } from "@/components/kb/FaqsTab";
import { PoliciesTab } from "@/components/kb/PoliciesTab";

const TABS = ["doctors", "profile", "services", "faqs", "policies"] as const;
type TabId = (typeof TABS)[number];

const SearchSchema = z.object({
  tab: z.enum(TABS).catch("doctors"),
});

export const Route = createFileRoute("/dashboard/knowledge")({
  component: KnowledgePage,
  validateSearch: (s) => SearchSchema.parse(s),
});

function KnowledgePage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Knowledge Base</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Everything the AI agent knows about your clinic — used live on every patient call.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => navigate({ to: "/dashboard/knowledge", search: { tab: v as TabId } })}>
        <TabsList>
          <TabsTrigger value="doctors">Doctors</TabsTrigger>
          <TabsTrigger value="profile">Clinic Profile</TabsTrigger>
          <TabsTrigger value="services">Services & Pricing</TabsTrigger>
          <TabsTrigger value="faqs">FAQs</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
        </TabsList>

        <TabsContent value="doctors" className="mt-6"><DoctorsTab /></TabsContent>
        <TabsContent value="profile" className="mt-6"><ClinicProfileTab /></TabsContent>
        <TabsContent value="services" className="mt-6"><ServicesTab /></TabsContent>
        <TabsContent value="faqs" className="mt-6"><FaqsTab /></TabsContent>
        <TabsContent value="policies" className="mt-6"><PoliciesTab /></TabsContent>
      </Tabs>
    </div>
  );
}
