-- 1. Clean up the old column from the patients table if it was introduced during the failed attempt
ALTER TABLE public.patients 
DROP COLUMN IF EXISTS ai_context_summary;

-- 2. Ensure the active conversational timeline column exists on individual call rows
ALTER TABLE public.calls 
ADD COLUMN IF NOT EXISTS agent_summary TEXT NULL;

-- 3. Document the column purpose for database administrators
COMMENT ON COLUMN public.calls.agent_summary IS 'Stores a dense, 1-2 sentence clinical summary generated post-call by the extraction worker daemon.';

-- 4. Create the specialized conditional composite index.
-- This ensures lookups matching `.not("agent_summary", "is", null)` resolve in <5ms.
CREATE INDEX IF NOT EXISTS idx_calls_patient_has_summary 
ON public.calls (patient_id, started_at DESC) 
WHERE (agent_summary IS NOT NULL);