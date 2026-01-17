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
app.use(express.static("public"));

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
  if (values.length === 0) {
    console.log("readAllRows: No values found in sheet");
    return { headers: [], rows: [] };
  }

  const headers = values[0] || [];
  if (headers.length === 0) {
    console.log("readAllRows: No headers found");
    return { headers: [], rows: [] };
  }

  const rows = values.slice(1)
    .filter(row => row && row.length > 0) // Filter out completely empty rows
    .map((row, idx) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = row[i] ?? ""));
      obj.__rowNumber = idx + 2; // header is row 1
      return obj;
    });

  console.log(`readAllRows: Returning ${headers.length} headers, ${rows.length} rows`);
  return { headers, rows };
}

async function readRow(rowNumber) {
  const sheets = await getSheetsClient();

  // Get headers
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1:Z1`,
  });

  const headers = (headerRes.data.values?.[0] || []);

  // Get specific row
  const rowRange = `${TAB}!A${rowNumber}:Z${rowNumber}`;
  const rowRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: rowRange,
  });

  const rowValues = rowRes.data.values?.[0] || [];
  const obj = {};
  headers.forEach((h, i) => (obj[h] = rowValues[i] ?? ""));
  obj.__rowNumber = rowNumber;

  return obj;
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

async function appendRow(rowData) {
  const sheets = await getSheetsClient();

  // Get headers to determine column order
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1:Z1`,
  });

  const headers = (headerRes.data.values?.[0] || []);
  
  // Build the row array in header order
  const newRow = headers.map(header => rowData[header] ?? "");

  // Append to the sheet
  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A:Z`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [newRow] },
  });

  // Extract the row number from the updated range
  const updatedRange = result.data.updates?.updatedRange || "";
  const match = updatedRange.match(/!A(\d+):/);
  const rowNumber = match ? parseInt(match[1], 10) : null;

  return { rowNumber, headers };
}

async function getHeaders() {
  const sheets = await getSheetsClient();
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1:Z1`,
  });
  return headerRes.data.values?.[0] || [];
}

// -------------------- Bland webhook schema (matches your payload) --------------------
// Using .nullable().optional() to handle fields that can be null, undefined, or a value
const BlandWebhookSchema = z.object({
  call_id: z.string(),
  c_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  completed: z.boolean().nullable().optional(),
  answered_by: z.string().nullable().optional(),
  call_length: z.number().nullable().optional(),
  recording_url: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  concatenated_transcript: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  phone_number: z.string().nullable().optional(),
  metadata: z
    .object({
      lead_id: z.string().nullable().optional(),
      property_id: z.string().nullable().optional(),
      sheet_row: z.number().nullable().optional(),
    })
    .passthrough()
    .nullable()
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
You are **Vibha**, a real estate associate at **Homeseek Realtors**, a trusted real estate advisory based in Gurugram. Homeseek’s mission is to be your partner in simplifying the process of finding, buying, or selling a home. :contentReference[oaicite:1]{index=1}

You are a trained property consultant who:
- Represents Homeseek Realtors directly
- Speaks confidently, professionally, and warmly
- Does NOT sound like a bot or proxy

Your role in this call:
- Provide accurate information from the listing
- Help leads understand the property and process
- Answer questions confidently using the best available information
- Guide the conversation toward a next step (e.g., walkthrough setup)

You are NOT authorized to:
- Negotiate pricing
- Guarantee availability
- Make legal or possession claims
- Guess facts that aren’t supported by the listing or safe domain knowledge

--------------------------------
CRITICAL BEHAVIOR RULES
--------------------------------
- Speak naturally, concise, confident, and empathetic
- Ask ONE question at a time
- Pause and listen fully after questions/answers
- Never rush to end the call
- Do NOT repeat apologies
- Do NOT say “I can’t help” without providing a helpful alternative
- When a lead challenges a fact:
  1) Acknowledge the challenge calmly
  2) Attempt clarification or reframe
  3) Provide a general real estate insight if needed
  4) Escalate to agent follow-up only after attempting clarification

--------------------------------
PROPERTY CONTEXT (FACTS ONLY)
--------------------------------
Address: ${row.property_address}
Configuration: ${row.property_beds_baths}
Price: ${row.property_price_inr}
Highlights:
${row.property_highlights}

Showings available: ${row.showing_windows}
Listing URL: ${row.property_url}

Use ONLY these facts when discussing specific details.

--------------------------------
GENERAL REAL ESTATE GUIDANCE (SAFE, PROFESSIONAL)
--------------------------------
When a question is outside the provided facts:
- Use general real estate knowledge, e.g., typical amenities, agent roles, or buying process
- Be informative, not speculative

Example fallback explanations:
- “That specific detail isn’t in the listing. In many modern residential properties, clubhouses often have common spaces — whether they include specialty services varies. I can confirm with the agent.”
- “As a real estate advisor, we help coordinate walkthroughs, share community insights, and connect you with the agent for deeper details.”

--------------------------------
CONVERSATION FLOW (FOLLOW THIS ORDER)
--------------------------------

Opening:
“Hi, this is Vibha from Homeseek Realtors. Is this a good time to talk?”

If they say “No”:  
“I understand — thank you for your time.”

Context:
“You had recently shown interest in a property we’re handling — does that sound right?”

Interest Check:
“Great — are you actively exploring properties in this area right now?”

Qualification:
“Are you looking to buy soon, or just exploring options?”
“Do you already have a budget range in mind?”

Property Q&A:
Answer using listing facts first.  
If not in listing, use general real estate knowledge (as above).

Soft Close:
“If it makes sense, we can organize a walkthrough and coordinate next steps. Would you like me to arrange that with Harshit?”

Ending:
“Thank you for your time — I’ll ensure this is followed up properly.”`.trim();
}



// -------------------- Start Bland call --------------------
async function startBlandCall({ phone, voiceId, task, webhook, metadata }) {
  // Detect if it's an India number (+91)
  const isIndiaNumber = phone.startsWith("+91");
  
  const callConfig = {
    phone_number: phone,
    voice: voiceId,
    record: true,
    wait_for_greeting: false,
    answered_by_enabled: true,
    voicemail_action: "hangup",
    interruption_threshold: 500,
    block_interruptions: false,
    language: isIndiaNumber ? "en-IN" : "en-US", // Use Indian English for India numbers
    model: "base",
    webhook,
    metadata,
    task,
  };

  console.log(`Starting Bland call to ${phone} (India: ${isIndiaNumber})`);

  const resp = await fetch("https://api.bland.ai/v1/calls", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BLAND_API_KEY}`,
    },
    body: JSON.stringify(callConfig),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`Bland API error for ${phone}: ${resp.status} ${txt}`);
    throw new Error(`Bland start call failed: ${resp.status} ${txt}`);
  }

  const result = await resp.json();
  console.log(`Bland call started: call_id=${result.call_id || result.id}`);
  return result;
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// Serve index.html for root path
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

/**
 * POST /trigger-call
 * Triggers a call for a specific sheet row.
 * Input: { "sheet_row": 2 }
 */
app.post("/trigger-call", async (req, res) => {
  try {
    const { sheet_row } = req.body;

    if (!sheet_row || typeof sheet_row !== "number" || sheet_row < 2) {
      return res.status(400).json({ ok: false, error: "Invalid sheet_row. Must be a number >= 2" });
    }

    // Read the specific row
    const row = await readRow(sheet_row);

    if (!row.phone_e164 || !row.phone_e164.trim().startsWith("+")) {
      return res.status(400).json({ ok: false, error: "Row missing valid phone_e164" });
    }

    if (!row.property_address || !row.property_address.trim()) {
      return res.status(400).json({ ok: false, error: "Row missing property_address" });
    }

    const rowNumber = row.__rowNumber;
    const attempts = Number(row.call_attempts || 0) + 1;

    // Mark as calling
    await updateRow(rowNumber, {
      call_status: "calling",
      call_attempts: String(attempts),
      last_call_at: new Date().toISOString(),
    });

    const task = buildPromptFromRow(row);

    // Metadata includes sheet_row for webhook -> update correct row
    const metadata = {
      lead_id: row.lead_id || "",
      property_id: row.property_id || "",
      sheet_row: rowNumber,
    };

    const startedAt = new Date().toISOString();

    try {
      const blandResp = await startBlandCall({
        phone: row.phone_e164,
        voiceId: row.voice_id || process.env.DEFAULT_VOICE_ID || "default",
        task,
        webhook: process.env.PUBLIC_WEBHOOK_URL,
        metadata,
      });

      const callId = blandResp.call_id || blandResp.id || "";

      // Save bland_call_id
      await updateRow(rowNumber, {
        bland_call_id: callId,
      });

      // Save to Supabase
      await supabase.from("calls").insert({
        lead_id: row.lead_id || null,
        property_id: row.property_id || null,
        phone_e164: row.phone_e164,
        bland_call_id: callId || null,
        status: "calling",
        outcome: null,
        next_action: null,
        attempt: attempts,
        started_at: startedAt,
        raw_webhook: { started_response: blandResp },
      });

      return res.json({
        ok: true,
        call_id: callId,
        sheet_row: rowNumber,
        message: "Call started successfully",
      });
    } catch (err) {
      console.error("Trigger call error:", err);

      await updateRow(rowNumber, {
        call_status: "failed",
        outcome: "human_followup",
        next_action: "human_followup",
        notes: `Failed to start call: ${String(err.message || err)}`,
      });

      await supabase.from("calls").insert({
        lead_id: row.lead_id || null,
        property_id: row.property_id || null,
        phone_e164: row.phone_e164,
        status: "failed",
        outcome: "human_followup",
        next_action: "human_followup",
        attempt: attempts,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        raw_webhook: { start_error: String(err.message || err) },
      });

      return res.status(500).json({
        ok: false,
        error: `Failed to start call: ${String(err.message || err)}`,
      });
    }
  } catch (err) {
    console.error("trigger-call failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * GET /rows
 * Returns all sheet rows for frontend display.
 */
app.get("/rows", async (req, res) => {
  try {
    console.log("GET /rows - fetching rows...");
    const { headers, rows } = await readAllRows();
    console.log(`GET /rows - found ${headers?.length || 0} headers, ${rows?.length || 0} rows`);
    return res.json({ ok: true, headers: headers || [], rows: rows || [] });
  } catch (err) {
    console.error("get rows failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * GET /headers
 * Returns the sheet headers for the add record form.
 */
app.get("/headers", async (req, res) => {
  try {
    const headers = await getHeaders();
    return res.json({ ok: true, headers });
  } catch (err) {
    console.error("get headers failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Generate a unique ID with prefix
function generateId(prefix) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * POST /add-row
 * Adds a new row to the Google Sheet.
 * Input: { "data": { "phone_e164": "+1234567890", "property_address": "...", ... } }
 * Auto-generates: lead_id, property_id, call_status, call_attempts, created_at
 */
app.post("/add-row", async (req, res) => {
  try {
    const { data } = req.body;

    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid data. Expected { data: { ... } }" });
    }

    // Auto-generate IDs and set defaults
    const rowData = {
      ...data,
      lead_id: data.lead_id || generateId("lead"),
      property_id: data.property_id || generateId("prop"),
      call_status: data.call_status || "queued",
      call_attempts: data.call_attempts || "0",
      created_at: new Date().toISOString(),
    };

    const { rowNumber } = await appendRow(rowData);

    console.log(`POST /add-row - added row at position ${rowNumber}, lead_id: ${rowData.lead_id}, property_id: ${rowData.property_id}`);

    return res.json({
      ok: true,
      message: "Row added successfully",
      row_number: rowNumber,
      lead_id: rowData.lead_id,
      property_id: rowData.property_id,
    });
  } catch (err) {
    console.error("add-row failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * PUT /update-row
 * Updates an existing row in the Google Sheet.
 * Input: { "sheet_row": 2, "data": { "phone_e164": "+1234567890", ... } }
 */
app.put("/update-row", async (req, res) => {
  try {
    const { sheet_row, data } = req.body;

    if (!sheet_row || typeof sheet_row !== "number" || sheet_row < 2) {
      return res.status(400).json({ ok: false, error: "Invalid sheet_row. Must be a number >= 2" });
    }

    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid data. Expected { data: { ... } }" });
    }

    // Update the row with provided data
    await updateRow(sheet_row, data);

    console.log(`PUT /update-row - updated row ${sheet_row}`);

    return res.json({
      ok: true,
      message: "Row updated successfully",
      row_number: sheet_row,
    });
  } catch (err) {
    console.error("update-row failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

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

    // Determine call_status based on outcome
    // Use outcome directly for: opt_out, no_answer, voicemail
    // Use "completed" for outcomes that mean the call connected: interested, human_followup
    const callStatusMap = {
      "opt_out": "opt_out",
      "no_answer": "no_answer",
      "voicemail": "voicemail",
      "interested": "completed",
      "human_followup": "completed",
    };
    const callStatus = callStatusMap[outcome] || "completed";

    console.log(`Webhook received: call_id=${callId}, answered_by=${answeredBy}, outcome=${outcome}, call_status=${callStatus}`);

    // Update sheet row
    if (rowNumber) {
      await updateRow(rowNumber, {
        call_status: callStatus,
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