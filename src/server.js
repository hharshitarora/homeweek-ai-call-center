/**
 * server.js — Phase 1B working server
 * Node + Express + Google Sheets + Supabase + Bland
 *
 * Endpoints:
 *   GET  /health
 *   POST /run-dialer
 *   POST /webhooks/bland
 */

import "dotenv/config";
import express from "express";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// -------------------- App --------------------
const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

// -------------------- Env checks --------------------
const REQUIRED_ENVS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
  "GOOGLE_SHEETS_SPREADSHEET_ID",
  "GOOGLE_SHEETS_TAB",
  "BLAND_API_KEY",
  "PUBLIC_WEBHOOK_URL",
];

for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

// -------------------- Supabase --------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------- Google Sheets --------------------
const SHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const TAB = process.env.GOOGLE_SHEETS_TAB;

function getGoogleAuth() {
  const json = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString("utf8")
  );

  return new google.auth.JWT({
    email: json.client_email,
    key: json.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetsClient() {
  const auth = getGoogleAuth();
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function readAllRows() {
  const sheets = await getSheetsClient();
  const range = `${TAB}!A1:Z10000`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });

  const values = res.data.values || [];
  if (values.length === 0) return { headers: [], rows: [] };

  const headers = values[0];
  const rows = values.slice(1).map((row, idx) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] ?? ""));
    obj.__rowNumber = idx + 2; // header is row 1
    return obj;
  });

  return { headers, rows };
}

async function updateRow(rowNumber, updates) {
  const sheets = await getSheetsClient();

  // Get headers so we can map key -> column index
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1:Z1`,
  });

  const headers = (headerRes.data.values?.[0] || []);
  const headerIndex = Object.fromEntries(headers.map((h, i) => [h, i]));

  // Get current row
  const rowRange = `${TAB}!A${rowNumber}:Z${rowNumber}`;
  const rowRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: rowRange,
  });

  const current = rowRes.data.values?.[0] || [];
  const newRow = [...current];

  for (const [key, value] of Object.entries(updates)) {
    const idx = headerIndex[key];
    if (idx === undefined) continue;
    newRow[idx] = value ?? "";
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: rowRange,
    valueInputOption: "RAW",
    requestBody: { values: [newRow] },
  });
}

// -------------------- Bland webhook schema (matches your payload) --------------------
const BlandWebhookSchema = z.object({
  call_id: z.string(),
  c_id: z.string().optional(),
  status: z.string().optional(),
  completed: z.boolean().optional(),
  answered_by: z.string().optional(),
  call_length: z.number().optional(),
  recording_url: z.string().optional(),
  summary: z.string().optional(),
  concatenated_transcript: z.string().optional(),
  to: z.string().optional(),
  phone_number: z.string().optional(),
  metadata: z
    .object({
      lead_id: z.string().optional(),
      property_id: z.string().optional(),
      sheet_row: z.number().optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

function classifyOutcome({ answeredBy, summary, transcript }) {
  const text = `${summary || ""}\n${transcript || ""}`.toLowerCase();

  // Opt out
  if (
    text.includes("do not call") ||
    text.includes("don't call") ||
    text.includes("stop calling") ||
    text.includes("remove me")
  ) {
    return { outcome: "opt_out", next_action: "none" };
  }

  // Not human = voicemail/no answer
  if (answeredBy && answeredBy.toLowerCase() !== "human") {
    if (answeredBy.toLowerCase().includes("voicemail")) {
      return { outcome: "voicemail", next_action: "call_back_later" };
    }
    return { outcome: "no_answer", next_action: "call_back_later" };
  }

  // Strong “interested” signals
  if (
    text.includes("agreed") &&
    (text.includes("walkthrough") || text.includes("visit") || text.includes("showing"))
  ) {
    return { outcome: "interested", next_action: "human_followup" };
  }
  if (text.includes("coordinate a visit") || text.includes("arrange a visit")) {
    return { outcome: "interested", next_action: "human_followup" };
  }

  // Soft interest / browsing
  if (text.includes("just browsing") || text.includes("exploring options")) {
    return { outcome: "human_followup", next_action: "human_followup" };
  }

  return { outcome: "human_followup", next_action: "human_followup" };
}

// -------------------- Build prompt from sheet row --------------------
function buildPromptFromRow(row) {
  return `
You are **Vibha**, a real estate associate at **Homeseek Realtors**.

You are a trained property consultant who represents the company directly.
You are confident, calm, professional, and helpful.
You do NOT sound like a bot, assistant, or proxy.

Your responsibility:
- Speak like a real Homeseek team member
- Guide the conversation professionally
- Handle questions and pushback without panicking
- Correct mistakes calmly if challenged

You are authorized to:
- Explain property basics (only from provided facts)
- Explain how Homeseek Realtors works
- Explain next steps in the buying process

You are NOT authorized to:
- Negotiate price
- Guarantee availability
- Make legal or possession claims
- Guess missing information

--------------------------------
CRITICAL BEHAVIOR RULES (MANDATORY)
--------------------------------
- Speak naturally, concise, and confidently
- Ask ONE question at a time
- Pause and listen fully after each question
- Never rush to end the call
- Never repeat apologies
- Never say “I can’t help” without attempting clarification

If the user challenges a fact:
1) Acknowledge the challenge calmly
2) Attempt to clarify or reframe
3) If still unclear, explain you will confirm and follow up
4) Escalate ONLY after attempting clarification

Do NOT immediately deflect to the agent.
Escalation must sound intentional, not evasive.

--------------------------------
PROPERTY CONTEXT (FACTS ONLY)
--------------------------------
Property Address: ${row.property_address}
Configuration: ${row.property_beds_baths}
Price: ${row.property_price_inr}
Highlights:
${row.property_highlights}

Showing Availability:
${row.showing_windows}

Listing URL:
${row.property_url}

You must NOT assume the property type beyond what is stated.
If the user questions the classification, acknowledge and clarify safely.

--------------------------------
HANDLING UNCERTAIN OR STICKY QUESTIONS
--------------------------------
If a question is outside the provided facts:
- Do NOT guess
- Do NOT shut down
- Respond professionally:

Example:
“That's a fair question. I want to make sure I give you accurate information, so I’ll have the agent confirm that detail before proceeding.”

--------------------------------
CONVERSATION FLOW (FOLLOW THIS ORDER)
--------------------------------

Opening:
“Hi, this is Vibha from Homeseek Realtors — is this a good time to talk?”

If they say yes → acknowledge and pause.
If they say no → continue.

Context:
“You had recently shown interest in a property we’re handling — does that sound right?”

Interest Check:
“Are you actively exploring properties in this area right now?”

Qualification:
“Are you looking to move ahead immediately, or are you still evaluating options?”
(Wait for response)

“Do you already have a budget range in mind?”
(Wait for response)

Engagement:
If they ask questions, answer calmly using only approved facts.
If challenged, follow the challenge-handling rules.

Soft Close:
“If it makes sense, we usually arrange a walkthrough and then discuss details more deeply.
Would you like me to coordinate the next step with the agent?”

Ending:
“Great — I’ll make sure this is followed up properly.
Thanks for your time, and feel free to ask if anything else comes up.”

--------------------------------
IMPORTANT
--------------------------------
You are part of Homeseek Realtors.
You speak with authority and professionalism.
You do not panic under pressure.
You represent the company’s credibility.
`.trim();
}


// -------------------- Start Bland call --------------------
async function startBlandCall({ phone, voiceId, task, webhook, metadata }) {
  const resp = await fetch("https://api.bland.ai/v1/calls", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BLAND_API_KEY}`,
    },
    body: JSON.stringify({
      phone_number: phone,
      voice: voiceId,
      record: true,
      wait_for_greeting: false,
      answered_by_enabled: true,
      voicemail_action: "hangup",
      interruption_threshold: 500,
      block_interruptions: false,
      language: "babel-en",
      model: "base",

      webhook,   // <- THIS is where Bland will POST the results
      metadata,  // <- THIS is how we know which sheet row to update

      task,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Bland start call failed: ${resp.status} ${txt}`);
  }

  return await resp.json();
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /run-dialer
 * Reads sheet rows with call_status=queued and starts up to 5 calls.
 */
app.post("/run-dialer", async (req, res) => {
  try {
    const { rows } = await readAllRows();

    const queued = rows
  .filter(r => String(r.call_status || "").toLowerCase() === "queued")
  .filter(r => Number(r.call_attempts || 0) < 3)
  .filter(r => String(r.phone_e164 || "").trim().startsWith("+"))
  .filter(r => String(r.property_address || "").trim().length > 0);


    const batch = queued.slice(0, 5);

    for (const row of batch) {
      const rowNumber = row.__rowNumber;
      const attempts = Number(row.call_attempts || 0) + 1;

      // mark as calling
      await updateRow(rowNumber, {
        call_status: "calling",
        call_attempts: String(attempts),
        last_call_at: new Date().toISOString(),
      });

      const task = buildPromptFromRow(row);

      // IMPORTANT: metadata includes sheet_row for webhook -> update correct row
      const metadata = {
        lead_id: row.lead_id,
        property_id: row.property_id,
        sheet_row: rowNumber,
      };

      const startedAt = new Date().toISOString();

      try {
        const blandResp = await startBlandCall({
          phone: row.phone_e164,
          voiceId: row.voice_id || process.env.DEFAULT_VOICE_ID,
          task,
          webhook: process.env.PUBLIC_WEBHOOK_URL,
          metadata,
        });

        const callId = blandResp.call_id || blandResp.id || "";

        await updateRow(rowNumber, {
          bland_call_id: callId,
        });

        await supabase.from("calls").insert({
          lead_id: row.lead_id,
          property_id: row.property_id,
          phone_e164: row.phone_e164,
          bland_call_id: callId || null,
          status: "calling",
          outcome: null,
          next_action: null,
          attempt: attempts,
          started_at: startedAt,
          raw_webhook: { started_response: blandResp },
        });
      } catch (err) {
        console.error("Dialer error:", err);

        await updateRow(rowNumber, {
          call_status: "failed",
          outcome: "human_followup",
          next_action: "human_followup",
          notes: `Failed to start call: ${String(err.message || err)}`,
        });

        await supabase.from("calls").insert({
          lead_id: row.lead_id,
          property_id: row.property_id,
          phone_e164: row.phone_e164,
          status: "failed",
          outcome: "human_followup",
          next_action: "human_followup",
          attempt: attempts,
          started_at: startedAt,
          ended_at: new Date().toISOString(),
          raw_webhook: { start_error: String(err.message || err) },
        });
      }
    }

    return res.json({ ok: true, processed: batch.length });
  } catch (err) {
    console.error("run-dialer failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * POST /webhooks/bland
 * Bland sends call results here after completion.
 */
app.post("/webhooks/bland", async (req, res) => {
  try {
    const payload = BlandWebhookSchema.parse(req.body);

    // Extract fields
    const callId = payload.call_id;
    const status = payload.status || "unknown";
    const answeredBy = payload.answered_by || "unknown";
    const durationSec = payload.call_length ? Math.round(payload.call_length) : null;
    const recordingUrl = payload.recording_url || "";
    const transcript = payload.concatenated_transcript || "";
    const summary = payload.summary || "";

    const meta = payload.metadata || {};
    const leadId = meta.lead_id || "";
    const propertyId = meta.property_id || "";
    const rowNumber = meta.sheet_row || null;

    const { outcome, next_action } = classifyOutcome({
      answeredBy,
      summary,
      transcript,
    });

    // Update sheet row
    if (rowNumber) {
      await updateRow(rowNumber, {
        call_status: outcome === "opt_out" ? "opt_out" : "completed",
        outcome,
        next_action,
        bland_call_id: callId,
        last_call_at: new Date().toISOString(),
        recording_url: recordingUrl,
        transcript: transcript,
        notes: summary,
      });
    }

    // Upsert supabase call record by bland_call_id
    await supabase
      .from("calls")
      .upsert(
        {
          bland_call_id: callId,
          lead_id: leadId,
          property_id: propertyId,
          phone_e164: payload.to || payload.phone_number || null,
          status,
          outcome,
          next_action,
          duration_sec: durationSec,
          transcript,
          recording_url: recordingUrl,
          raw_webhook: req.body,
          ended_at: new Date().toISOString(),
        },
        { onConflict: "bland_call_id" }
      );

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------- Start server --------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});