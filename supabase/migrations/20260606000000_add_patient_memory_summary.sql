-- Add the unified summary text column to the patients table if it doesn't exist
ALTER TABLE patients 
ADD COLUMN IF NOT EXISTS ai_context_summary TEXT;

-- Add an index on phone_number to optimize incoming caller lookups for new vs old checks
CREATE INDEX IF NOT EXISTS idx_patients_phone_number 
ON patients(phone_number);

COMMENT ON COLUMN patients.ai_context_summary IS 'Stores a single, auto-updated conversational profile and previous context summary for the patient.';