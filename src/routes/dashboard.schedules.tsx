import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AppointmentsTab } from "@/components/schedules/AppointmentsTab";
import { CalendarDays, Construction } from "lucide-react";

const TABS = ["appointments", "callbacks"] as const;
type TabId = (typeof TABS)[number];

const SearchSchema = z.object({
  tab: z.enum(TABS).catch("appointments"),
});

export const Route = createFileRoute("/dashboard/schedules")({
  component: SchedulesPage,
  validateSearch: (s) => SearchSchema.parse(s),
});

function SchedulesPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Schedules</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upcoming appointments and callbacks booked through inbound calls
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) =>
          navigate({ to: "/dashboard/schedules", search: { tab: v as TabId } })
        }
      >
        <TabsList>
          <TabsTrigger value="appointments">
            <CalendarDays className="h-3.5 w-3.5 mr-1.5" />
            Appointments
          </TabsTrigger>
          <TabsTrigger value="callbacks">
            Callbacks
          </TabsTrigger>
        </TabsList>

        <TabsContent value="appointments" className="mt-6">
          <AppointmentsTab />
        </TabsContent>

        <TabsContent value="callbacks" className="mt-6">
          <div className="rounded-xl border bg-card p-16 text-center">
            <Construction className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-medium text-lg">Work in Progress</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs mx-auto">
              Callback scheduling is being built. Check back soon.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
