import { supabase } from "../../config/supabase.js";

export async function findLeadByBolnaExecutionId(executionId) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("bolna_execution_id", executionId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("findLeadByBolnaExecutionId error:", error.message);
  }
  return data || null;
}

export async function findLikelyActiveBolnaLeadByPhone(phoneE164) {
  if (!phoneE164) return null;
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("phone_e164", phoneE164)
    .eq("call_provider", "bolna")
    .order("last_call_at", { ascending: false })
    .limit(3);

  if (error) return null;
  const leads = data || [];
  const active = leads.find((l) => String(l.call_status || "").toLowerCase() === "calling");
  return active || leads[0] || null;
}

export async function upsertBolnaCallTracking({
  executionId, lead, leadId, propertyId, phoneE164, status, outcome = null,
  nextAction = null, durationSec = null, transcript = "", recordingUrl = "",
  providerOutcomeRaw = null, providerOutcomeNormalized = null,
  outcomeSource = null, payload, isTerminal,
}) {
  const nowIso = new Date().toISOString();
  const trimmedTranscript = typeof transcript === "string" ? transcript.slice(0, 50000) : "";

  await supabase.from("calls").insert({
    bolna_execution_id: executionId,
    lead_id: leadId || (lead?.lead_id),
    status,
    outcome,
    duration_sec: durationSec,
    transcript: trimmedTranscript,
    recording_url: recordingUrl
  });

  if (leadId || lead?.id) {
    await supabase.from("leads").update({
      call_status: status,
      outcome,
      next_action: nextAction,
      transcript: trimmedTranscript,
      recording_url: recordingUrl,
      last_call_at: nowIso
    }).eq("id", leadId || lead.id);
  }
}
