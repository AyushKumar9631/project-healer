import { createClient } from "@supabase/supabase-js";
import { CampaignAutomationOrchestratorService, SupabaseCampaignCallQueueService } from "../index";
import { runFeedbackAnalysis } from "../tasks/feedback";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    "Worker boot failure: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.",
  );
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const queueService = new SupabaseCampaignCallQueueService();
const orchestrator = new CampaignAutomationOrchestratorService(queueService);

const TICK_INTERVAL_MS = 1000; // 1-second interval for active calls
const SCHEDULE_CHECK_INTERVAL_MS = 60000; // 60-second interval for checking the schedule

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkAndStartScheduledCampaigns() {
  try {
    const now = new Date().toISOString();

    const { data: campaigns, error } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .lte("scheduled_at", now)
      .neq("status", "running")
      .neq("status", "completed");

    if (error || !campaigns || campaigns.length === 0) return;

    for (const campaign of campaigns) {
      console.log(`[Scheduler] Waking up scheduled campaign: ${campaign.name} (${campaign.id})`);

      await supabaseAdmin
        .from("campaign_call_queue")
        .update({
          status: "retry_scheduled",
          call_id: null,
          last_error: "Auto-reset by scheduler before run",
        })
        .eq("campaign_id", campaign.id)
        .in("status", ["dialing", "in_progress"]);

      let patientsQuery = supabaseAdmin.from("patients").select("id, phone");
      if (campaign.patient_list_id) {
        patientsQuery = patientsQuery.eq("patient_list_id", campaign.patient_list_id);
      } else if (campaign.clinic_id) {
        patientsQuery = patientsQuery.eq("clinic_id", campaign.clinic_id);
      }
      const { data: campaignPatients } = await patientsQuery;

      const { data: existingQueue } = await supabaseAdmin
        .from("campaign_call_queue")
        .select("id, patient_id, status")
        .eq("campaign_id", campaign.id);

      const existingPatientIds = new Set(existingQueue?.map((q) => q.patient_id) || []);

      const newPatients =
        campaignPatients?.filter((p) => p.phone && !existingPatientIds.has(p.id)) || [];

      if (newPatients.length > 0) {
        const queueInserts = newPatients.map((p) => ({
          campaign_id: campaign.id,
          patient_id: p.id,
          clinic_id: campaign.clinic_id,
          phone_number: p.phone,
          status: "pending",
        }));
        await supabaseAdmin.from("campaign_call_queue").insert(queueInserts);
      }

      const reactivateIds =
        existingQueue
          ?.filter((q) => q.status === "failed" || q.status === "retry_scheduled")
          .map((q) => q.id) || [];

      if (reactivateIds.length > 0) {
        await supabaseAdmin
          .from("campaign_call_queue")
          .update({
            status: "pending",
            call_id: null,
            last_error: null,
          })
          .in("id", reactivateIds);
      }

      await supabaseAdmin
        .from("campaigns")
        .update({
          status: "running",
          scheduled_at: null,
        })
        .eq("id", campaign.id);

      console.log(`[Scheduler] Successfully started campaign: ${campaign.name}`);
    }
  } catch (err) {
    console.error("[Scheduler] Error processing scheduled campaigns:", err);
  }
}

// --- Production-Safe Self-Scheduling Thread Structure ---
let isFeedbackWorkerRunning = false;
function initializeTranscriptSummarizerLoop() {
  async function runTick() {
    if (isFeedbackWorkerRunning) {
      scheduleNext();
      return;
    }
    try {
      isFeedbackWorkerRunning = true;
      // Cleans up transcripts, triggers Gemini summaries, and writes back into agent_summary
      await runFeedbackAnalysis(supabaseAdmin); 
    } catch (err) {
      console.error("[Worker Scribe Engine] Failure encountered in loop evaluation tick:", err);
    } finally {
      isFeedbackWorkerRunning = false;
      scheduleNext(); // Cooldown step strictly calculated post-transaction resolution
    }
  }
  function scheduleNext() {
    setTimeout(runTick, 60000); // Evaluates candidate logs meticulously once every minute
  }
  scheduleNext();
}
// --------------------------------------------------------

async function runWorker() {
  console.log("Jilo Health Campaign Dialer Worker Started...");

  let lastScheduleCheck = 0;
  
  // Kick off the isolated background feedback task loop
  initializeTranscriptSummarizerLoop();

  while (true) {
    const startTime = Date.now();

    try {
      if (startTime - lastScheduleCheck >= SCHEDULE_CHECK_INTERVAL_MS) {
        await checkAndStartScheduledCampaigns();
        lastScheduleCheck = Date.now();
      }

      const { data: running, error } = await supabaseAdmin
        .from("campaigns")
        .select("id")
        .eq("status", "running");

      if (error) {
        console.error("[Worker] Failed to fetch running campaigns:", error.message);
      } else if (running && running.length > 0) {
        for (const c of running) {
          console.log(`[Worker] Ticking campaign: ${c.id}`);

          const tick = await orchestrator.runTick({ campaignId: c.id });

          const drained =
            tick.analytics.summary.total > 0 &&
            tick.analytics.summary.pending === 0 &&
            tick.analytics.summary.active === 0;

          if (drained) {
            await supabaseAdmin
              .from("campaigns")
              .update({ status: "completed", completed_at: new Date().toISOString() })
              .eq("id", c.id);
            console.log(`[Worker] Campaign ${c.id} completed.`);
          }

          await supabaseAdmin
            .from("campaigns")
            .update({ completed_calls: tick.analytics.summary.completed })
            .eq("id", c.id);
        }
      }
    } catch (error) {
      console.error("[Worker Exception] Error inside tick loop:", error);
    }

    const executionTime = Date.now() - startTime;
    const delay = Math.max(0, TICK_INTERVAL_MS - executionTime);
    await sleep(delay);
  }
}

process.on("SIGTERM", () => {
  console.log("Stopping campaign worker gracefully...");
  process.exit(0);
});

runWorker();