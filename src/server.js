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
import cors from "cors";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// -------------------- App --------------------
const app = express();

// Enable CORS for all routes
app.use(cors({
  origin: true, // Allow all origins (or specify your Cloudflare Pages domain)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

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

// -------------------- Defaults --------------------
const DEFAULT_VOICE_ID = "095a1518-ecdf-4870-a5ff-c74b43a08764";

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

async function deleteRow(rowNumber) {
  const sheets = await getSheetsClient();
  
  // Get the sheet ID for the tab
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });
  
  const sheet = spreadsheet.data.sheets.find(s => s.properties.title === TAB);
  if (!sheet) {
    throw new Error(`Sheet tab "${TAB}" not found`);
  }
  
  const sheetId = sheet.properties.sheetId;
  
  // Delete the row using batchUpdate
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheetId,
              dimension: "ROWS",
              startIndex: rowNumber - 1, // 0-indexed, rowNumber is 1-indexed
              endIndex: rowNumber, // endIndex is exclusive
            },
          },
        },
      ],
    },
  });
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

function classifyOutcome({ answeredBy, summary, transcript, completed, callLength, dispositionTag }) {
  // Use Bland's disposition_tag if available (Bland's own classification)
  if (dispositionTag) {
    const dispositionLower = dispositionTag.toLowerCase();
    
    // Map Bland's disposition tags to our outcomes
    if (dispositionLower === "interested") {
      return { outcome: "interested", next_action: "human_followup" };
    }
    if (dispositionLower === "not_interested" || dispositionLower === "not interested") {
      return { outcome: "human_followup", next_action: "human_followup" };
    }
    if (dispositionLower === "opt_out" || dispositionLower === "opt out") {
      return { outcome: "opt_out", next_action: "none" };
    }
    if (dispositionLower === "voicemail") {
      return { outcome: "voicemail", next_action: "call_back_later" };
    }
    if (dispositionLower === "no_answer" || dispositionLower === "no answer") {
      return { outcome: "no_answer", next_action: "call_back_later" };
    }
    // If disposition_tag exists but doesn't match known values, still use it as signal
    // but fall through to our own analysis
  }

  const text = `${summary || ""}\n${transcript || ""}`.toLowerCase();
  
  // Check if there's a meaningful conversation (transcript with user responses)
  const hasConversation = transcript && (
    transcript.includes("user:") || 
    transcript.toLowerCase().includes("user") ||
    (transcript.length > 100 && callLength && callLength > 5) // Substantial transcript with reasonable duration
  );

  // Opt out
  if (
    text.includes("do not call") ||
    text.includes("don't call") ||
    text.includes("stop calling") ||
    text.includes("remove me")
  ) {
    return { outcome: "opt_out", next_action: "none" };
  }

  // If there's a conversation, analyze it regardless of answered_by value
  // "unknown" can still mean a human answered, just not detected
  if (hasConversation) {
    // Strong "interested" signals
    if (
      text.includes("agreed") &&
      (text.includes("walkthrough") || text.includes("visit") || text.includes("showing"))
    ) {
      return { outcome: "interested", next_action: "human_followup" };
    }
    if (text.includes("coordinate a visit") || text.includes("arrange a visit")) {
      return { outcome: "interested", next_action: "human_followup" };
    }
    
    // Check for interest in the summary (from the webhook payload example)
    if (text.includes("expressed interest") || text.includes("interested in learning more")) {
      return { outcome: "interested", next_action: "human_followup" };
    }

    // Soft interest / browsing
    if (text.includes("just browsing") || text.includes("exploring options")) {
      return { outcome: "human_followup", next_action: "human_followup" };
    }

    // If call completed with conversation but no clear signals, default to follow-up
    if (completed) {
      return { outcome: "human_followup", next_action: "human_followup" };
    }
  }

  // Not human = voicemail/no answer (only if no conversation detected)
  if (answeredBy && answeredBy.toLowerCase() !== "human" && !hasConversation) {
    if (answeredBy.toLowerCase().includes("voicemail")) {
      return { outcome: "voicemail", next_action: "call_back_later" };
    }
    return { outcome: "no_answer", next_action: "call_back_later" };
  }

  // Default: if we got here and call completed, assume human follow-up needed
  if (completed) {
    return { outcome: "human_followup", next_action: "human_followup" };
  }

  return { outcome: "human_followup", next_action: "human_followup" };
}

// -------------------- Build prompt from sheet row --------------------
function buildPromptFromRow(row) {
  return `
You are a professional real estate calling agent representing Homeseek Realtors, a trusted real estate advisory based in Gurugram. Homeseek’s mission is to be a partner in simplifying the process of finding, evaluating, and purchasing residential property.

You are a trained property consultant who:
- Speaks confidently, professionally, and warmly
- Does NOT sound like a bot or proxy
- Adapts naturally to Hinglish when the lead uses Hindi

Your role in this call:
- Introduce the area and the project
- Gauge interest and intent
- Answer project- and area-related questions confidently
- Qualify the lead for senior agent follow-up

You are NOT authorized to:
- Negotiate pricing
- Guarantee availability
- Make legal or possession claims
- Provide details not supported by the project facts or safe general real estate context

--------------------------------
LANGUAGE & HINGLISH BEHAVIOR
--------------------------------
Default language: English.

If the user responds in Hindi or uses a Hindi/English mix:
- Reply initially in Hinglish
- Then continue in English unless the user continues in Hindi

Do NOT force Hindi on users who speak only English.

--------------------------------
CRITICAL BEHAVIOR RULES
--------------------------------
- Speak naturally, concisely, confidently, and empathetically
- Ask ONE question at a time
- Pause and listen fully after each question or answer
- Never rush to end the call
- Do NOT repeat apologies
- Do NOT say “I can’t help” without offering a helpful alternative
- If a lead challenges a fact:
  1) Acknowledge the concern calmly
  2) Attempt clarification or reframe
  3) Provide a general real estate insight if appropriate
  4) Escalate to senior agent follow-up only after attempting clarification

--------------------------------
LEAD CONTEXT
--------------------------------
${row.lead_name ? `Lead Name: ${row.lead_name}` : 'Lead name not provided'}

--------------------------------
PROJECT CONTEXT (FACTS ONLY)
--------------------------------
Project: ${row.property_name}
Area: ${row.property_address}
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
- Use general real estate knowledge (e.g., typical amenities, agent roles, buying process)
- Be informative, not speculative

Example fallback:
“That specific detail isn’t listed. In many modern residential projects, clubhouses typically include common facilities, and additional services can vary. I can confirm this with the senior agent.”

--------------------------------
CONVERSATION FLOW (FOLLOW THIS ORDER)
--------------------------------

**Opening / Hook**
“Hi, I’m calling from Homeseek Realtors. Is this a good time to talk?”

If “No”:
- “Thank you for your time — have a great day.”

**Location & Interest Check**
“Are you currently looking for properties around Golf Course Road or nearby sectors?”

**Area + Project Introduction**
“We’re reaching out because we have an interesting project in the Golf Course Road area called *${row.property_name}*. It offers premium residences with a range of amenities. Does that sound relevant to what you’re exploring?”

**Qualification – End User vs Investor**
“Quick question — are you looking as an end user or as an investor?”
“Are you actively looking to move ahead soon, or just exploring options at the moment?”
“Do you have a budget range in mind at this stage?”

**Project & Amenities Q&A**
- Answer using project facts first
- If asked about the builder or area benefits:
  - Share general information about the developer if available (e.g., reputation or track record)
  - Provide relevant area context such as connectivity, schools, or hospitals

If a question is outside the listed facts, use general real estate guidance as outlined above.

**Soft Close / Next Steps**
“Thanks for sharing. Based on your interest, the senior agent can follow up to discuss next steps, coordinate a site visit, and go over the details.”

**Ending**
“Thank you for your time — I’ll ensure this is passed along to the senior agent.”


`.trim();
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

    // Server-side lock: reject if already calling (allow recalling for testing)
    const currentStatus = (row.call_status || "").toLowerCase();
    if (currentStatus === "calling") {
      return res.status(409).json({ 
        ok: false, 
        error: "Call already in progress. Please wait for it to complete." 
      });
    }
    
    // For testing: allow recalling completed/queued/failed calls
    // Only block if actively calling

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
        voiceId: row.voice_id || DEFAULT_VOICE_ID,
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
 * DELETE /delete-row
 * Deletes a row from the Google Sheet.
 * Input: { "sheet_row": 2 }
 */
app.delete("/delete-row", async (req, res) => {
  try {
    const { sheet_row } = req.body;

    if (!sheet_row || typeof sheet_row !== "number" || sheet_row < 2) {
      return res.status(400).json({ ok: false, error: "Invalid sheet_row. Must be a number >= 2" });
    }

    // Prevent deleting header row
    if (sheet_row === 1) {
      return res.status(400).json({ ok: false, error: "Cannot delete header row" });
    }

    await deleteRow(sheet_row);

    console.log(`DELETE /delete-row - deleted row ${sheet_row}`);

    return res.json({
      ok: true,
      message: "Row deleted successfully",
      row_number: sheet_row,
    });
  } catch (err) {
    console.error("delete-row failed:", err);
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
          voiceId: row.voice_id || DEFAULT_VOICE_ID,
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

    // Extract Bland's disposition_tag if available (Bland's own classification)
    const dispositionTag = payload.disposition_tag || null;

    const { outcome, next_action } = classifyOutcome({
      answeredBy,
      summary,
      transcript,
      completed: payload.completed || false,
      callLength: payload.call_length || null,
      dispositionTag,
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