import { createFileRoute } from "@tanstack/react-router";
import { HMISSyncManager } from "@/lib/hmis-integration/sync-manager.server";
import { HMISConfig } from "@/lib/hmis-integration/types";

// Helper function to return JSON responses (matching your codebase style)
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/hmis/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();

          const config: HMISConfig = {
            clinicId: "615ddc42-e0a4-4183-9289-15d23c4ce6ed",
            adapterType: body.adapterType,
            connectionString: body.connectionString,
            listName: body.listName,
            tableName: body.tableName,
          };

          const manager = new HMISSyncManager();
          const result = await manager.runSync(config);

          return json(result, 200);
        } catch (error: any) {
          console.error("HMIS Sync API Error:", error);
          return json({ success: false, error: error.message }, 500);
        }
      },
    },
  },
});
