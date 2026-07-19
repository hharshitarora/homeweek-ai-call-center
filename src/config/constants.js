export const LEAD_HEADERS = [
  "id", "lead_id", "lead_name", "phone_e164", "email",
  "property_id", "property_name", "property_address", "property_price_inr",
  "property_beds_baths", "property_highlights", "showing_windows", "property_url",
  "call_status", "call_attempts", "last_call_at", "bland_call_id", "bolna_execution_id",
  "call_provider", "outcome", "next_action", "notes", "transcript", "recording_url",
  "summary", "voice_id", "dataset_id", "source_row_number", "created_at", "updated_at"
];

export const REQUIRED_ENVS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BOLNA_API_KEY",
  "BOLNA_AGENT_ID",
];
