/**
 * server.js — Phase 1B working server
 * Node + Express + Google Sheets + Supabase + Bland + Bolna
 *
 * Endpoints:
 *   GET  /health
 *   GET  /rows
 *   GET  /headers
 *   POST /add-row
 *   POST /upload-csv
 *   PUT  /update-row
 *   DELETE /delete-row
 *   POST /trigger-call        - Single call (supports provider: "bland" | "bolna")
 *   POST /run-dialer          - Bulk calls (supports bolna_ratio for A/B testing)
 *   POST /webhooks/bland      - Bland call completion webhook
 *   POST /webhooks/bolna      - Bolna call completion webhook
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import multer from "multer";
import { parse } from "csv-parse/sync";

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

// Configure multer for file uploads (memory storage)
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;

// -------------------- Environment Mode --------------------
const NODE_ENV = process.env.NODE_ENV || "production";
const IS_DEV = NODE_ENV === "development";

if (IS_DEV) {
  console.log("🔧 Running in DEVELOPMENT mode");
} else {
  console.log("🚀 Running in PRODUCTION mode");
}

// -------------------- Env checks --------------------
const REQUIRED_ENVS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
  "GOOGLE_SHEETS_SPREADSHEET_ID",
  "GOOGLE_SHEETS_TAB",
  "BLAND_API_KEY",
  "BOLNA_API_KEY",
  "BOLNA_AGENT_ID",
];

// In dev mode, PUBLIC_WEBHOOK_URL is optional (will use localhost)
if (!IS_DEV) {
  REQUIRED_ENVS.push("PUBLIC_WEBHOOK_URL");
}

for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

// Determine webhook URL: use env var, or localhost in dev mode
const PUBLIC_WEBHOOK_URL = process.env.PUBLIC_WEBHOOK_URL || 
  (IS_DEV ? `http://localhost:${PORT}/webhooks/bland` : null);

if (!PUBLIC_WEBHOOK_URL) {
  console.error("Missing PUBLIC_WEBHOOK_URL");
  process.exit(1);
}

// Derive Bolna webhook URL from the same base domain
const BOLNA_WEBHOOK_URL = PUBLIC_WEBHOOK_URL.replace('/webhooks/bland', '/webhooks/bolna');

console.log(`📡 Bland Webhook URL: ${PUBLIC_WEBHOOK_URL}`);
console.log(`📡 Bolna Webhook URL: ${BOLNA_WEBHOOK_URL}`);

// -------------------- WhatsApp Notification Config --------------------
// Optional env vars for WhatsApp alerts (Twilio)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g., "whatsapp:+14155238886"
const SENIOR_AGENT_WHATSAPP = process.env.SENIOR_AGENT_WHATSAPP; // e.g., "whatsapp:+919876543210"

// In-memory deduplication: track leads notified today
// Key: lead_id or phone, Value: date string (YYYY-MM-DD)
const whatsappNotifiedToday = new Map();

/**
 * Send WhatsApp notification for hot leads via Twilio
 * Fails silently - never throws or blocks the caller
 */
async function sendWhatsAppHotLeadAlert({ leadName, phoneE164, propertyName, callSummary }) {
  try {
    // Check if WhatsApp config is available
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !SENIOR_AGENT_WHATSAPP) {
      // WhatsApp not configured - skip silently
      return;
    }

    // Deduplication: one message per lead (by phone) per day
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const dedupeKey = phoneE164 || "unknown";
    
    if (whatsappNotifiedToday.get(dedupeKey) === today) {
      // Already notified today - skip
      return;
    }

    // Build the message
    const message = `🔥 Hot Lead Alert
Name: ${leadName || "Unknown"}
Phone: ${phoneE164 || "N/A"}
Project: ${propertyName || "Tulip Monsella"}
Summary: ${callSummary || "No summary available"}
Next step: Follow-up recommended`;

    // Send via Twilio WhatsApp API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const formData = new URLSearchParams();
    formData.append("From", TWILIO_WHATSAPP_FROM);
    formData.append("To", SENIOR_AGENT_WHATSAPP);
    formData.append("Body", message);

    const resp = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    if (resp.ok) {
      // Mark as notified today
      whatsappNotifiedToday.set(dedupeKey, today);
      console.log(`WhatsApp alert sent for lead: ${dedupeKey}`);
    } else {
      const errText = await resp.text();
      console.error(`WhatsApp send failed: ${resp.status} ${errText}`);
    }
  } catch (err) {
    // Log error silently - never throw
    console.error(`WhatsApp notification error: ${err.message || err}`);
  }
}

// Clean up old entries from deduplication map (runs daily at midnight)
function cleanupWhatsAppDedupeMap() {
  const today = new Date().toISOString().split("T")[0];
  for (const [key, date] of whatsappNotifiedToday.entries()) {
    if (date !== today) {
      whatsappNotifiedToday.delete(key);
    }
  }
}

// Schedule cleanup every hour
setInterval(cleanupWhatsAppDedupeMap, 60 * 60 * 1000);

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

async function deleteRowsBulk(rowNumbers) {
  if (!rowNumbers || rowNumbers.length === 0) {
    return;
  }

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

  // Sort row numbers in descending order to avoid index shifting issues
  const sortedRows = [...rowNumbers].filter(r => r >= 2).sort((a, b) => b - a);

  if (sortedRows.length === 0) {
    return;
  }

  // Create delete requests for each row
  const requests = sortedRows.map(rowNumber => ({
    deleteDimension: {
      range: {
        sheetId: sheetId,
        dimension: "ROWS",
        startIndex: rowNumber - 1, // 0-indexed, rowNumber is 1-indexed
        endIndex: rowNumber, // endIndex is exclusive
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests },
  });
}

// -------------------- Batch Update Rows --------------------

function getColLetter(n) {
  let char = "";
  while (n >= 0) {
    char = String.fromCharCode(n % 26 + 65) + char;
    n = Math.floor(n / 26) - 1;
  }
  return char;
}

async function updateRowsBatch(updates) {
  const sheets = await getSheetsClient();

  // Get headers to map keys to columns
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1:Z1`,
  });

  const headers = (headerRes.data.values?.[0] || []);
  const headerIndex = Object.fromEntries(headers.map((h, i) => [h, i]));

  // Construct data for batchUpdate
  const data = updates.map(({ rowNumber, values }) => {
    return Object.entries(values).map(([key, val]) => {
      const colIdx = headerIndex[key];
      if (colIdx === undefined) return null;
      
      const colLetter = getColLetter(colIdx);
      
      return {
        range: `${TAB}!${colLetter}${rowNumber}`,
        values: [[val]]
      };
    }).filter(Boolean);
  }).flat();

  if (data.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    resource: {
      valueInputOption: "RAW",
      data: data
    }
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

// -------------------- Bolna webhook schema --------------------
// Zod v4: z.record() requires two args (key, value). z.record(z.any()) is invalid and causes _zod undefined.
// Bolna can send telephony_data.duration as string (e.g. "85") or number.
const BolnaWebhookSchema = z.object({
  id: z.string().nullable().optional(), // execution_id
  execution_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  batch_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(), // completed, call-disconnected, no-answer, busy, failed, etc.
  conversation_time: z.number().nullable().optional(),
  total_cost: z.number().nullable().optional(),
  transcript: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  answered_by_voice_mail: z.boolean().nullable().optional(),
  error_message: z.string().nullable().optional(),
  telephony_data: z.object({
    duration: z.union([z.string(), z.number()]).nullable().optional(), // Bolna may send "85" or 85
    to_number: z.string().nullable().optional(),
    from_number: z.string().nullable().optional(),
    recording_url: z.string().nullable().optional(),
    call_type: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    hangup_by: z.string().nullable().optional(),
    hangup_reason: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  extracted_data: z.record(z.string(), z.unknown()).nullable().optional(),
  context_details: z.record(z.string(), z.unknown()).nullable().optional(), // Contains our user_data variables
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
You are a professional real estate calling agent representing TrueValue Realtors, a trusted real estate advisory based in Gurugram. TrueValue’s mission is to be a partner in simplifying the process of finding, evaluating, and purchasing residential property.

You are calling as a member of the TrueValue team.
You speak confidently, professionally, and warmly.
You do NOT sound like a bot or proxy.

--------------------------------
YOUR ROLE IN THIS CALL
--------------------------------
- Introduce the area and the project
- Gauge interest and intent
- Answer project- and area-related questions confidently
- Qualify the lead for senior agent follow-up

This is a lead-generation call, not a closing call.

--------------------------------
YOU ARE NOT AUTHORIZED TO
--------------------------------
- Negotiate pricing
- Guarantee availability or possession
- Make legal or possession claims
- Provide details not supported by project facts or safe general real estate context
- Share any personal or direct contact number
- Discuss other projects besides Tulip Monsella

--------------------------------
CRITICAL BEHAVIOR RULES
--------------------------------
- Speak naturally, concise, confident, and empathetic
- Ask ONE question at a time
- Pause and listen fully after each response
- Never rush to end the call
- Do NOT repeat apologies
- Do NOT say “I can’t help” without offering a constructive next step

**Other Projects**
- If asked about other projects (not Tulip Monsella), say: "I'm currently handling Tulip Monsella. For other projects, our senior agent can assist you."

**Call Length Control**
- Answer in 2-3 sentences per turn. The lead may ask several questions about Tulip Monsella — that is normal. Keep answering; do NOT wrap up or redirect just because they asked multiple questions.
- Only wrap up and hand to senior agent when: (a) the topic is clearly off-topic (not about Tulip Monsella or real estate), or (b) the call has been very long and repetitive with no progress. When wrapping up, say only: "I appreciate your time. Let me have our senior agent follow up with you." Do NOT say "get back to conversation flow" or similar.

**Silence & Pause Handling**
- If the lead pauses or takes time to respond, wait patiently.
- If there is brief silence, say **“Take your time.”** once and wait.
- Do NOT move to the next question without a response.

**Contact & Identity Handling**
- If asked for your phone number or contact details:
  - Do NOT invent or share any number.
  - Respond that follow-ups happen via official TrueValue channels.
  - Continue the conversation calmly; do NOT end the call.

If the lead challenges a fact:
1) Acknowledge calmly  
2) Clarify or reframe using available knowledge  
3) Provide general real estate context if appropriate  
4) Escalate to senior agent follow-up only if needed  

--------------------------------
LEAD CONTEXT
--------------------------------
${row.lead_name ? `Lead Name: ${row.lead_name}` : 'Lead name not provided'}
Phone Number: ${row.phone_e164}

You are calling this person directly as part of a professional outreach by TrueValue Realtors.

--------------------------------
PROJECT KNOWLEDGE — TULIP MONSELLA
--------------------------------
Tulip Monsella is a premium luxury residential project located on Golf Course Road, Sector 53, Gurgaon. It is positioned for high-end end users and long-term investors seeking large, fully loaded homes in a prime central location.

The project spans approximately 20 acres and offers a limited collection of 3, 4, and 5 BHK residences, designed with a focus on privacy, lifestyle, and construction quality.

CONFIGURATION & POSITIONING
- 3, 4, and 5 BHK residences
- 3 BHK starts from approx. 2299 sq. ft.
- Fully loaded apartments
- Private lift lobbies per apartment
- Smart home: VRV AC, home automation, video door phone
- High-speed elevators

LOCATION
- Sector 53, Golf Course Road, Gurgaon
- One of Gurgaon’s most premium residential corridors
- Strong connectivity to business hubs, schools, and conveniences

KEY AMENITIES (Highlights)
CLUBHOUSE & SKY DECK:
- 1 lakh sq. ft. clubhouse across two levels
- Sky Clubhouse on 41st floor with observation deck and sky lounge
- Fine-dining restaurant, restro bar, cigar lounge
- Mini theatre, business center, salon & spa

SPORTS & FITNESS:
- 2.5-acre sports academy by international cricketer
- Olympic-size rooftop swimming pool + kids' pool
- Tennis, basketball, badminton, squash courts
- Fully-equipped gym + outdoor gym on deck

LIFESTYLE & WELLNESS:
- Jacuzzi, sauna, steam rooms, yoga deck
- Landscaped gardens, jogging/cycling tracks
- Pet-friendly zones with dedicated pet garden

SECURITY & CONVENIENCE:
- 5-tier security system with CCTV
- Zero vehicular movement on ground level
- 100% power backup
- Dedicated basement parking

BUILDER — TULIP GROUP
Well-regarded Gurgaon developer. Known for timely delivery, zero-debt model, and Mivan construction.

PRICING (INDICATIVE)
- Starts around ₹8.5 Cr* (inventory dependent)
- All pricing, availability, and payment details must be confirmed by a senior agent.

POSSESSION
- Expected around 2028 (indicative, not guaranteed)

--------------------------------
GENERAL REAL ESTATE GUIDANCE
--------------------------------
If a question is outside the provided project facts:
- Use safe, general real estate knowledge
- Be informative, not speculative

Example:
“That detail isn’t specifically listed. In many luxury residential projects, certain services or features can vary. The senior agent can confirm the exact details for you.”

--------------------------------
CONVERSATION FLOW (FOLLOW THIS ORDER)
--------------------------------

Opening  
“Hi, I’m calling from TrueValue Realtors. Is this a good time to talk?”

If No →  
“Understood. Thank you for your time.”

Interest & Location Check  
“Are you currently exploring properties around Golf Course Road or nearby sectors?”

Project Introduction  
“We’re reaching out because we’re handling a premium project on Golf Course Road called Tulip Monsella. It offers spacious luxury residences with a strong amenity setup. Does that align with what you’re looking for?”

Qualification  
“Just to understand better — are you looking as an end user or as an investor?”  
“Are you actively looking to move ahead soon, or still exploring options?”  
“Do you have a budget range in mind at this stage?”

Q&A  
Answer using project knowledge first.  
Escalate only when confirmation is required.

Soft Close  
“Based on your interest, the senior agent can follow up to discuss details and coordinate a site visit if needed.”

Ending  
“Thank you for your time. I’ll ensure this is shared for follow-up.”
`.trim();
}



// -------------------- Start Bland call --------------------
async function startBlandCall({ phone, voiceId, task, webhook, metadata }) {
  // Detect if it's an India number (+91)
  const isIndiaNumber = phone.startsWith("+91");
  const fromNumber = process.env.BLAND_FROM_NUMBER || "+14154492886";

  const callConfig = {
    phone_number: phone,
    from_number: fromNumber,
    voice: voiceId,
    record: true,
    wait_for_greeting: false,
    answered_by_enabled: true,
    noise_cancellation: true,
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

// -------------------- Start Bolna call (Hinglish) --------------------
async function startBolnaCall({ phone, userData }) {
  const callPayload = {
    agent_id: process.env.BOLNA_AGENT_ID,
    recipient_phone_number: phone,
    user_data: userData, // Context variables: {lead_name, property_name, lead_id, sheet_row, etc.}
  };

  console.log(`Starting Bolna call to ${phone} with agent ${process.env.BOLNA_AGENT_ID}`);

  const resp = await fetch("https://api.bolna.ai/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
    },
    body: JSON.stringify(callPayload),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`Bolna API error for ${phone}: ${resp.status} ${txt}`);
    throw new Error(`Bolna start call failed: ${resp.status} ${txt}`);
  }

  const result = await resp.json();
  console.log(`Bolna call started: execution_id=${result.execution_id}`);
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
 * Input: { "sheet_row": 2, "provider": "bland" | "bolna" }
 * provider defaults to "bland" (English). Use "bolna" for Hinglish calls.
 */
app.post("/trigger-call", async (req, res) => {
  try {
    const { sheet_row, provider = "bland" } = req.body;

    // Validate provider
    if (!["bland", "bolna"].includes(provider)) {
      return res.status(400).json({ ok: false, error: "Invalid provider. Must be 'bland' or 'bolna'" });
    }

    if (!sheet_row || typeof sheet_row !== "number" || sheet_row < 2) {
      return res.status(400).json({ ok: false, error: "Invalid sheet_row. Must be a number >= 2" });
    }

    // Read the specific row
    const row = await readRow(sheet_row);

    if (!row.phone_e164 || !row.phone_e164.trim().startsWith("+")) {
      return res.status(400).json({ ok: false, error: "Row missing valid phone_e164" });
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

    // Mark as calling with provider info
    await updateRow(rowNumber, {
      call_status: "calling",
      call_attempts: String(attempts),
      last_call_at: new Date().toISOString(),
      call_provider: provider, // Track which provider is being used
    });

    const startedAt = new Date().toISOString();

    try {
      let callId = "";
      let callResponse = null;

      if (provider === "bolna") {
        // -------------------- BOLNA (Hinglish) --------------------
        // Bolna uses pre-configured agent with context variables
        const userData = {
          lead_name: row.lead_name || "",
          phone_e164: row.phone_e164,
          property_name: row.property_name || "Tulip Monsella",
          lead_id: row.lead_id || "",
          property_id: row.property_id || "",
          sheet_row: String(rowNumber), // Bolna expects strings in user_data
        };

        const bolnaResp = await startBolnaCall({
          phone: row.phone_e164,
          userData,
        });

        callId = bolnaResp.execution_id || "";
        callResponse = bolnaResp;

        // Save bolna_execution_id to sheet
        await updateRow(rowNumber, {
          bolna_execution_id: callId,
        });

        // Save to Supabase with bolna_execution_id
        await supabase.from("calls").insert({
          lead_id: row.lead_id || null,
          property_id: row.property_id || null,
          phone_e164: row.phone_e164,
          bolna_execution_id: callId || null,
          call_provider: "bolna",
          status: "calling",
          outcome: null,
          next_action: null,
          attempt: attempts,
          started_at: startedAt,
          raw_webhook: { started_response: bolnaResp },
        });

      } else {
        // -------------------- BLAND (English - default) --------------------
        const task = buildPromptFromRow(row);

        // Metadata includes sheet_row for webhook -> update correct row
        const metadata = {
          lead_id: row.lead_id || "",
          property_id: row.property_id || "",
          sheet_row: rowNumber,
        };

        const blandResp = await startBlandCall({
          phone: row.phone_e164,
          voiceId: row.voice_id || DEFAULT_VOICE_ID,
          task,
          webhook: PUBLIC_WEBHOOK_URL,
          metadata,
        });

        callId = blandResp.call_id || blandResp.id || "";
        callResponse = blandResp;

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
          call_provider: "bland",
          status: "calling",
          outcome: null,
          next_action: null,
          attempt: attempts,
          started_at: startedAt,
          raw_webhook: { started_response: blandResp },
        });
      }

      return res.json({
        ok: true,
        call_id: callId,
        provider,
        sheet_row: rowNumber,
        message: `Call started successfully via ${provider}`,
      });
    } catch (err) {
      console.error(`Trigger call error (${provider}):`, err);

      await updateRow(rowNumber, {
        call_status: "failed",
        outcome: "human_followup",
        next_action: "human_followup",
        notes: `Failed to start ${provider} call: ${String(err.message || err)}`,
      });

      await supabase.from("calls").insert({
        lead_id: row.lead_id || null,
        property_id: row.property_id || null,
        phone_e164: row.phone_e164,
        call_provider: provider,
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
        error: `Failed to start ${provider} call: ${String(err.message || err)}`,
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
 * Normalize phone number for India-only calling
 * - If number is `91XXXXXXXXXX` → convert to `+91XXXXXXXXXX`
 * - If number is `XXXXXXXXXX` → convert to `+91XXXXXXXXXX`
 * - Returns null if invalid
 */
function normalizePhoneForIndia(phone) {
  if (!phone || typeof phone !== "string") return null;
  
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, "");
  
  // If it's already in +91 format, validate length
  if (phone.startsWith("+91")) {
    const numPart = phone.substring(3).replace(/\D/g, "");
    if (numPart.length === 10) {
      return `+91${numPart}`;
    }
    return null;
  }
  
  // If it starts with 91 and has 12 digits total (91 + 10 digits)
  if (digits.startsWith("91") && digits.length === 12) {
    return `+91${digits.substring(2)}`;
  }
  
  // If it's 10 digits, assume it's an India number
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  
  // Invalid format
  return null;
}

/**
 * POST /upload-csv
 * Accepts a CSV file via multipart/form-data and imports leads.
 * CSV format: Name, Mobile Number, Email, Date, Interested in
 * Ignores Type column and all other columns.
 */
app.post("/upload-csv", upload.single("csv"), async (req, res) => {
  try {
    console.log("POST /upload-csv - request received");
    console.log("File:", req.file ? "present" : "missing");
    console.log("Body keys:", Object.keys(req.body || {}));
    
    if (!req.file) {
      console.log("No file in request");
      return res.status(400).json({ ok: false, error: "No CSV file provided" });
    }

    // Parse CSV
    const csvContent = req.file.buffer.toString("utf8");
    let records;
    
    try {
      records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true, // Allow extra columns
      });
    } catch (parseError) {
      console.error("CSV parse error:", parseError);
      return res.status(400).json({ ok: false, error: `Invalid CSV format: ${parseError.message}` });
    }

    if (records.length === 0) {
      return res.status(400).json({ ok: false, error: "CSV file is empty or has no valid rows" });
    }

    // Get headers to determine column mapping
    const headers = await getHeaders();
    
    let inserted = 0;
    let skipped = 0;
    const errors = [];

    // Process each row
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      
      // Extract required fields (case-insensitive matching)
      const name = row["Name"] || row["name"] || "";
      const mobileNumber = row["Mobile Number"] || row["mobile number"] || row["Mobile"] || row["mobile"] || "";
      const email = row["Email"] || row["email"] || "";
      // Date and Interested in are not stored, but we read them for validation if needed
      
      // Normalize phone number
      const phoneE164 = normalizePhoneForIndia(mobileNumber);
      
      if (!phoneE164) {
        skipped++;
        errors.push(`Row ${i + 2}: Invalid phone number "${mobileNumber}"`);
        continue;
      }

      // Build row data matching the sheet schema
      const rowData = {
        lead_name: name.trim() || "",
        phone_e164: phoneE164,
        email: email.trim() || "",
        call_status: "queued",
        call_attempts: "0",
        created_at: new Date().toISOString(),
      };

      // Auto-generate IDs
      rowData.lead_id = generateId("lead");
      rowData.property_id = generateId("prop");

      // Fill in any other required headers with empty strings
      headers.forEach(header => {
        if (!(header in rowData)) {
          rowData[header] = "";
        }
      });

      try {
        await appendRow(rowData);
        inserted++;
      } catch (appendError) {
        skipped++;
        errors.push(`Row ${i + 2}: Failed to append - ${appendError.message}`);
        console.error(`Failed to append row ${i + 2}:`, appendError);
      }
    }

    console.log(`POST /upload-csv - inserted: ${inserted}, skipped: ${skipped}`);

    return res.json({
      ok: true,
      inserted,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("upload-csv failed:", err);
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
 * DELETE /delete-rows-bulk
 * Deletes multiple rows from the Google Sheet.
 * Input: { "sheet_rows": [2, 3, 5] }
 */
app.delete("/delete-rows-bulk", async (req, res) => {
  try {
    const { sheet_rows } = req.body;

    if (!Array.isArray(sheet_rows) || sheet_rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid sheet_rows. Must be a non-empty array of row numbers >= 2" });
    }

    // Validate all row numbers
    const invalidRows = sheet_rows.filter(r => typeof r !== "number" || r < 2);
    if (invalidRows.length > 0) {
      return res.status(400).json({ ok: false, error: `Invalid row numbers: ${invalidRows.join(", ")}. All must be >= 2` });
    }

    // Prevent deleting header row
    if (sheet_rows.includes(1)) {
      return res.status(400).json({ ok: false, error: "Cannot delete header row" });
    }

    await deleteRowsBulk(sheet_rows);

    console.log(`DELETE /delete-rows-bulk - deleted ${sheet_rows.length} rows`);

    return res.json({
      ok: true,
      message: `${sheet_rows.length} row(s) deleted successfully`,
      deleted_count: sheet_rows.length,
    });
  } catch (err) {
    console.error("delete-rows-bulk failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * POST /run-dialer
 * Bulk Dialing with A/B testing support for Bland (English) and Bolna (Hinglish).
 * Reads queued rows and starts calls based on bolna_ratio.
 * Input: { "limit": 25, "bolna_ratio": 50 }
 *   - limit: max leads to call (default 5, max 50)
 *   - bolna_ratio: percentage of leads to call via Bolna/Hinglish (0-100, default 0)
 */
app.post("/run-dialer", async (req, res) => {
  try {
    const { limit = 5, bolna_ratio = 0 } = req.body;
    const maxRows = Math.min(Math.max(Number(limit), 1), 50);
    const bolnaPercent = Math.min(Math.max(Number(bolna_ratio), 0), 100);

    const { rows } = await readAllRows();

    // Filter leads that are ready to call
    const queued = rows
      .filter(r => String(r.call_status || "").toLowerCase() === "queued")
      .filter(r => Number(r.call_attempts || 0) < 3)
      .filter(r => String(r.phone_e164 || "").trim().startsWith("+"))
      .slice(0, maxRows);

    if (queued.length === 0) {
      return res.json({ ok: true, processed: 0, message: "No queued leads found" });
    }

    // Split leads based on bolna_ratio
    const bolnaCount = Math.round(queued.length * (bolnaPercent / 100));
    const bolnaLeads = queued.slice(0, bolnaCount);
    const blandLeads = queued.slice(bolnaCount);

    console.log(`Bulk dialing: ${queued.length} total, ${bolnaLeads.length} via Bolna, ${blandLeads.length} via Bland`);

    const startedAt = new Date().toISOString();
    let bolnaSuccessCount = 0;
    let blandBatchId = null;

    // -------------------- BOLNA CALLS (Hinglish) --------------------
    // Bolna doesn't have a simple batch API like Bland, so we make individual calls
    // For production scale, consider using Bolna's CSV batch upload API
    if (bolnaLeads.length > 0) {
      console.log(`Starting ${bolnaLeads.length} Bolna calls...`);
      
      for (const row of bolnaLeads) {
        try {
          const attempts = Number(row.call_attempts || 0) + 1;
          
          // Mark as calling
          await updateRow(row.__rowNumber, {
            call_status: "calling",
            call_attempts: String(attempts),
            last_call_at: startedAt,
            call_provider: "bolna",
          });

          // Prepare user_data for Bolna
          const userData = {
            lead_name: row.lead_name || "",
            phone_e164: row.phone_e164,
            property_name: row.property_name || "Tulip Monsella",
            lead_id: row.lead_id || "",
            property_id: row.property_id || "",
            sheet_row: String(row.__rowNumber),
          };

          const bolnaResp = await startBolnaCall({
            phone: row.phone_e164,
            userData,
          });

          const executionId = bolnaResp.execution_id || "";

          // Save execution_id to sheet
          await updateRow(row.__rowNumber, {
            bolna_execution_id: executionId,
          });

          // Save to Supabase
          await supabase.from("calls").insert({
            lead_id: row.lead_id || null,
            property_id: row.property_id || null,
            phone_e164: row.phone_e164,
            bolna_execution_id: executionId || null,
            call_provider: "bolna",
            status: "calling",
            outcome: null,
            next_action: null,
            attempt: attempts,
            started_at: startedAt,
            raw_webhook: { started_response: bolnaResp },
          });

          bolnaSuccessCount++;
        } catch (bolnaErr) {
          console.error(`Bolna call failed for ${row.phone_e164}:`, bolnaErr);
          
          // Mark as failed
          await updateRow(row.__rowNumber, {
            call_status: "failed",
            notes: `Bolna call failed: ${String(bolnaErr.message || bolnaErr)}`,
          });
        }
      }
    }

    // -------------------- BLAND CALLS (English) --------------------
    if (blandLeads.length > 0) {
      // Prepare Call Objects for Bland Batch
      const callObjects = blandLeads.map(row => {
        const task = buildPromptFromRow(row);
        const isIndiaNumber = row.phone_e164.startsWith("+91");

        return {
          phone_number: row.phone_e164,
          task: task,
          language: isIndiaNumber ? "en-IN" : "en-US",
          metadata: {
            lead_id: row.lead_id,
            property_id: row.property_id,
            sheet_row: row.__rowNumber,
          }
        };
      });

      // Prepare Sheet Updates (mark as calling)
      const blandSheetUpdates = blandLeads.map(row => {
        const attempts = Number(row.call_attempts || 0) + 1;
        return {
          rowNumber: row.__rowNumber,
          values: {
            call_status: "calling",
            call_attempts: String(attempts),
            last_call_at: startedAt,
            call_provider: "bland",
          }
        };
      });

      // Send Batch to Bland
      console.log(`Triggering Bland Batch for ${blandLeads.length} numbers`);
      
      const globalTask = callObjects.length > 0 ? callObjects[0].task : buildPromptFromRow(blandLeads[0]);
      
      const batchPayload = {
        call_objects: callObjects,
        global: {
          task: globalTask,
          voice: DEFAULT_VOICE_ID,
          webhook: PUBLIC_WEBHOOK_URL,
          record: true,
          wait_for_greeting: false,
          answered_by_enabled: true,
          voicemail_action: "hangup",
          interruption_threshold: 500,
          model: "base"
        }
      };

      const blandResp = await fetch("https://api.bland.ai/v2/batches/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${process.env.BLAND_API_KEY}`,
        },
        body: JSON.stringify(batchPayload),
      });

      if (!blandResp.ok) {
        const txt = await blandResp.text();
        throw new Error(`Bland Batch API failed: ${blandResp.status} ${txt}`);
      }

      const blandResult = await blandResp.json();
      console.log("Bland Batch created:", blandResult);
      blandBatchId = blandResult.data?.batch_id;

      // Update Sheets in Batch
      await updateRowsBatch(blandSheetUpdates);
    }

    return res.json({
      ok: true,
      processed: queued.length,
      bolna_calls: bolnaSuccessCount,
      bland_calls: blandLeads.length,
      bland_batch_id: blandBatchId,
      message: `Started ${bolnaSuccessCount} Bolna (Hinglish) + ${blandLeads.length} Bland (English) calls`
    });

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

    // WhatsApp Hot Lead Alert: fire only when outcome is "interested"
    if (outcome === "interested") {
      // Get lead details for the alert (read from sheet if we have row number)
      let leadName = "";
      let propertyName = "Tulip Monsella"; // Default project name
      
      if (rowNumber) {
        try {
          const rowData = await readRow(rowNumber);
          leadName = rowData.lead_name || "";
          propertyName = rowData.property_name || rowData.property_address || "Tulip Monsella";
        } catch (readErr) {
          // Ignore read errors - use defaults
        }
      }
      
      // Send WhatsApp notification (non-blocking, fails silently)
      sendWhatsAppHotLeadAlert({
        leadName,
        phoneE164: payload.to || payload.phone_number || "",
        propertyName,
        callSummary: summary,
      });
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Bland webhook error:", err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * POST /webhooks/bolna
 * Bolna sends call results here after completion.
 */
app.post("/webhooks/bolna", async (req, res) => {
  try {
    // Guard: body can be undefined if Content-Type is wrong or body is empty (Zod v4 can throw _zod on undefined)
    const raw = req.body ?? {};
    const parseResult = BolnaWebhookSchema.safeParse(raw);
    if (!parseResult.success) {
      console.error("Bolna webhook validation failed:", parseResult.error?.issues ?? parseResult.error);
      return res.status(400).json({ ok: false, error: "Invalid webhook payload", details: parseResult.error?.issues });
    }
    const payload = parseResult.data;

    // Extract fields - Bolna uses different field names than Bland
    const executionId = payload.execution_id || payload.id || "";
    const status = payload.status || "unknown";
    const transcript = payload.transcript || "";
    // telephony_data.duration can be string ("85") or number; coerce to number for downstream use
    const durationSecRaw = payload.telephony_data?.duration ?? payload.conversation_time ?? null;
    const durationSec = durationSecRaw != null ? Number(durationSecRaw) : null;
    const recordingUrl = payload.telephony_data?.recording_url || "";
    const answeredByVoicemail = payload.answered_by_voice_mail || false;
    const hangupReason = payload.telephony_data?.hangup_reason || "";

    // Extract context_details which contains our user_data variables
    const contextDetails = payload.context_details || {};
    const leadId = contextDetails.lead_id || "";
    const propertyId = contextDetails.property_id || "";
    const rowNumber = contextDetails.sheet_row ? Number(contextDetails.sheet_row) : null;

    // Map Bolna status to answered_by for classifyOutcome compatibility
    let answeredBy = "unknown";
    if (answeredByVoicemail) {
      answeredBy = "voicemail";
    } else if (status === "completed") {
      answeredBy = "human";
    } else if (status === "no-answer") {
      answeredBy = "no_answer";
    }

    // Use our existing classifyOutcome function
    const { outcome, next_action } = classifyOutcome({
      answeredBy,
      summary: payload.summary ?? "",
      transcript,
      completed: status === "completed",
      callLength: durationSec,
      dispositionTag: null, // Bolna uses extracted_data instead
    });

    // Override outcome based on Bolna-specific status
    let finalOutcome = outcome;
    let finalNextAction = next_action;
    
    if (status === "no-answer") {
      finalOutcome = "no_answer";
      finalNextAction = "call_back_later";
    } else if (status === "busy") {
      finalOutcome = "no_answer";
      finalNextAction = "call_back_later";
    } else if (answeredByVoicemail) {
      finalOutcome = "voicemail";
      finalNextAction = "call_back_later";
    }

    // Determine call_status based on outcome
    const callStatusMap = {
      "opt_out": "opt_out",
      "no_answer": "no_answer",
      "voicemail": "voicemail",
      "interested": "completed",
      "human_followup": "completed",
    };
    const callStatus = callStatusMap[finalOutcome] || "completed";

    console.log(`Bolna webhook received: execution_id=${executionId}, status=${status}, outcome=${finalOutcome}, call_status=${callStatus}`);

    // Update sheet row
    if (rowNumber) {
      await updateRow(rowNumber, {
        call_status: callStatus,
        outcome: finalOutcome,
        next_action: finalNextAction,
        bolna_execution_id: executionId,
        last_call_at: new Date().toISOString(),
        recording_url: recordingUrl,
        transcript: transcript,
        notes: `Bolna call - ${hangupReason || status}`,
      });
    }

    // Upsert supabase call record by bolna_execution_id
    await supabase
      .from("calls")
      .upsert(
        {
          bolna_execution_id: executionId,
          lead_id: leadId || null,
          property_id: propertyId || null,
          phone_e164: payload.telephony_data?.to_number || null,
          call_provider: "bolna",
          status,
          outcome: finalOutcome,
          next_action: finalNextAction,
          duration_sec: durationSec,
          transcript,
          recording_url: recordingUrl,
          raw_webhook: raw,
          ended_at: new Date().toISOString(),
        },
        { onConflict: "bolna_execution_id" }
      );

    // WhatsApp Hot Lead Alert: fire only when outcome is "interested"
    if (finalOutcome === "interested") {
      let leadName = "";
      let propertyName = contextDetails.property_name || "Tulip Monsella";
      
      if (rowNumber) {
        try {
          const rowData = await readRow(rowNumber);
          leadName = rowData.lead_name || contextDetails.lead_name || "";
          propertyName = rowData.property_name || rowData.property_address || propertyName;
        } catch (readErr) {
          // Ignore read errors - use defaults
          leadName = contextDetails.lead_name || "";
        }
      }
      
      // Send WhatsApp notification (non-blocking, fails silently)
      sendWhatsAppHotLeadAlert({
        leadName,
        phoneE164: payload.telephony_data?.to_number || "",
        propertyName,
        callSummary: `Bolna Hinglish call - Lead showed interest. Duration: ${durationSec || 0}s`,
      });
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Bolna webhook error:", err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// Serve static files AFTER all API routes
app.use(express.static("public"));

// -------------------- Error Handling Middleware --------------------
// Handle multer and other errors - must be after all routes
app.use((err, req, res, next) => {
  console.error("Error middleware caught:", err);
  // Check if it's a multer error (MulterError has a code property)
  if (err && err.code && err.code.startsWith('LIMIT_')) {
    console.error("Multer error:", err);
    return res.status(400).json({ ok: false, error: `File upload error: ${err.message}` });
  }
  if (err) {
    console.error("Unhandled error:", err);
    // Only return JSON for API routes (especially upload-csv)
    if (req.path === '/upload-csv' || req.path.startsWith('/api/') || req.headers['content-type']?.includes('application/json')) {
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
    // For other routes, let Express handle it
    return next(err);
  }
  next();
});

// -------------------- Start server --------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
