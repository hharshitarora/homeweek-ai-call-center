/**
 * server.js — Phase 2: Supabase as primary database
 * Node + Express + Supabase + Bolna + Ringg AI
 *
 * Endpoints:
 *   GET  /health
 *   GET  /rows
 *   GET  /headers
 *   POST /add-row
 *   POST /upload-csv
 *   PUT  /update-row
 *   PUT  /update-rows-bulk
 *   DELETE /delete-row
 *   DELETE /delete-rows-bulk
 *   POST /trigger-call        - Single call (Bolna or Ringg); auth: session cookie or API key (TRIGGER_API_KEY / API_KEY)
 *   POST /run-dialer          - Bulk calls (Bolna only); same auth as trigger-call
 *   POST /webhooks/bolna      - Bolna call completion webhook
 *   POST /webhooks/ringg      - Ringg AI call event webhooks
 */

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import multer from "multer";
import nodemailer from "nodemailer";
import { parse } from "csv-parse/sync";

// -------------------- App --------------------
const app = express();

// Enable CORS for all routes
app.use(cors({
  origin: true, // Allow all origins (or specify your Cloudflare Pages domain)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
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
  (IS_DEV ? `http://localhost:${PORT}/webhooks/bolna` : null);

if (!PUBLIC_WEBHOOK_URL) {
  console.error("Missing PUBLIC_WEBHOOK_URL");
  process.exit(1);
}

const BOLNA_WEBHOOK_URL = PUBLIC_WEBHOOK_URL;

// Bolna requires batch schedule time to be at least 2 minutes in the future.
// Keep a buffer for clock skew / provider-side validation.
const BOLNA_MIN_SCHEDULE_SECONDS = 120;
const BOLNA_BATCH_SCHEDULE_DELAY_SECONDS = Math.max(
  Number(process.env.BOLNA_BATCH_SCHEDULE_DELAY_SECONDS || 150),
  BOLNA_MIN_SCHEDULE_SECONDS
);

console.log(`📡 Bolna Webhook URL: ${BOLNA_WEBHOOK_URL}`);

// -------------------- Ringg AI Config --------------------
// Optional: set RINGG_API_KEY, RINGG_AGENT_ID, RINGG_FROM_NUMBER_ID to enable Ringg provider.
const RINGG_ENABLED = Boolean(process.env.RINGG_API_KEY && process.env.RINGG_AGENT_ID && process.env.RINGG_FROM_NUMBER_ID);
if (RINGG_ENABLED) {
  console.log("📡 Ringg AI provider enabled");
} else {
  console.log("ℹ️  Ringg AI provider disabled (set RINGG_API_KEY, RINGG_AGENT_ID, RINGG_FROM_NUMBER_ID to enable)");
}

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

// -------------------- Auth --------------------
// Static password: set LOGIN_USERNAME + LOGIN_PASSWORD + SESSION_SECRET (no email needed).
// Or email OTP: LOGIN_USERNAME + LOGIN_EMAIL(S) + SESSION_SECRET + (Resend | Gmail | SendGrid).
const LOGIN_USERNAME = (process.env.LOGIN_USERNAME || "").trim();
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD; // plain; set for static password login
const LOGIN_EMAIL_RAW = (process.env.LOGIN_EMAIL || "").trim();
const LOGIN_EMAILS = LOGIN_EMAIL_RAW ? LOGIN_EMAIL_RAW.split(",").map((e) => e.trim()).filter(Boolean) : [];
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = (process.env.RESEND_FROM || "Homeseek Command Center <onboarding@resend.dev>").trim();
const GMAIL_USER = (process.env.GMAIL_USER || "").trim();
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = (process.env.SENDGRID_FROM || "").trim();
const SESSION_SECRET = process.env.SESSION_SECRET;
const EMAIL_SENDER_OK = !!(RESEND_API_KEY || (GMAIL_USER && GMAIL_APP_PASSWORD) || (SENDGRID_API_KEY && SENDGRID_FROM));
const PASSWORD_AUTH = !!(LOGIN_USERNAME && LOGIN_PASSWORD && SESSION_SECRET);
const OTP_AUTH = !!(LOGIN_USERNAME && LOGIN_EMAILS.length > 0 && EMAIL_SENDER_OK && SESSION_SECRET);
const AUTH_ENABLED = !!(LOGIN_USERNAME && SESSION_SECRET && (LOGIN_PASSWORD || (LOGIN_EMAILS.length > 0 && EMAIL_SENDER_OK)));
// Optional: allow API key for protected routes (e.g. when cookies aren't sent cross-origin or for server-to-server)
const API_KEY = process.env.TRIGGER_API_KEY || process.env.API_KEY || "";

if (AUTH_ENABLED) {
  console.log("🔐 Auth enabled:", PASSWORD_AUTH ? "static password" : "OTP (email)");
  if (API_KEY) console.log("🔑 API key auth enabled for protected routes (Bearer or X-API-Key)");
} else {
  console.log("🔓 Auth disabled: set LOGIN_USERNAME, SESSION_SECRET, and either LOGIN_PASSWORD or (LOGIN_EMAIL + email sender)");
}

let gmailTransporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  gmailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });
}

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_COOKIE_NAME = "session";
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// In-memory OTP store: key = username (lowercase), value = { otp, expiresAt, email, attemptId }
const otpStore = new Map();

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(";").forEach((s) => {
    const i = s.indexOf("=");
    if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return out;
}

function signSession(payload) {
  const data = JSON.stringify(payload);
  const b64 = Buffer.from(data, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

function verifySession(value) {
  if (!value || typeof value !== "string") return null;
  const i = value.lastIndexOf(".");
  if (i <= 0) return null;
  const b64 = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

const OTP_HTML = (otp) =>
  `<p>Your one-time login code is: <strong>${otp}</strong></p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`;

async function sendOtpEmail(to, otp) {
  if (SENDGRID_API_KEY && SENDGRID_FROM) {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: (() => {
        const m = SENDGRID_FROM.match(/^(.+?)\s*<([^>]+)>$/);
        return m ? { name: m[1].trim(), email: m[2].trim() } : { name: "Homeseek", email: SENDGRID_FROM };
      })(),
        subject: "Your Homeseek Command Center login code",
        content: [{ type: "text/html", value: OTP_HTML(otp) }],
      }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error("SendGrid API error:", res.status, bodyText);
      throw new Error(`SendGrid ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    return;
  }
  if (gmailTransporter) {
    try {
      await gmailTransporter.sendMail({
        from: GMAIL_USER,
        to,
        subject: "Your Homeseek Command Center login code",
        html: OTP_HTML(otp),
      });
    } catch (err) {
      if (err.code === "ETIMEDOUT" || err.message?.includes("timeout") || err.message?.includes("Connection timeout")) {
        console.error("Gmail SMTP timeout – many clouds block outbound SMTP. Use SendGrid (HTTPS) or Resend with a verified domain instead.");
      }
      throw err;
    }
    return;
  }
  const from = RESEND_FROM || "Homeseek Command Center <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Your Homeseek Command Center login code",
      html: OTP_HTML(otp),
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    console.error("Resend API error:", res.status, bodyText);
    throw new Error(`Resend ${res.status}: ${bodyText.slice(0, 200)}`);
  }
}

async function logLoginAttempt({ username, email_sent, verified = false }) {
  try {
    const { data, error } = await supabase
      .from("login_attempts")
      .insert({ username: username.toLowerCase(), email_sent, verified })
      .select("id")
      .single();
    if (error) throw error;
    return data?.id ?? null;
  } catch (err) {
    console.error("logLoginAttempt error:", err.message);
    return null;
  }
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  // 1) Session cookie (browser, same-origin or cross-origin with credentials)
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  const session = verifySession(token);
  if (session && session.user) {
    req.user = session.user;
    return next();
  }
  // 2) API key (Bearer or X-API-Key) so trigger-call/run-dialer work when cookies aren't sent (e.g. cross-origin or scripts)
  if (API_KEY && typeof API_KEY === "string" && API_KEY.length > 0) {
    const authHeader = req.headers.authorization;
    const bearer = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const xApiKey = (req.headers["x-api-key"] || "").trim();
    if ((bearer && bearer === API_KEY) || (xApiKey && xApiKey === API_KEY)) {
      req.user = "api-key";
      return next();
    }
  }
  return res.status(401).json({ ok: false, error: "Login required" });
}

const PROTECTED_PATHS = [
  "/rows", "/headers", "/add-row", "/update-row", "/update-rows-bulk", "/delete-row", "/delete-rows-bulk",
  "/trigger-call", "/run-dialer", "/upload-csv",
];
function isProtectedPath(path) {
  return PROTECTED_PATHS.some((p) => path === p || path.startsWith(p + "?"));
}

// -------------------- Supabase Data Functions --------------------
// These replace the old Google Sheets functions

// Static headers list (columns in the leads table)
const LEAD_HEADERS = [
  "id", "lead_id", "lead_name", "phone_e164", "email",
  "property_id", "property_name", "property_address", "property_price_inr",
  "property_beds_baths", "property_highlights", "showing_windows", "property_url",
  "call_status", "call_attempts", "last_call_at", "bland_call_id", "bolna_execution_id",
  "call_provider", "outcome", "next_action", "notes", "transcript", "recording_url",
  "summary", "voice_id", "dataset_id", "source_row_number", "created_at", "updated_at"
];

async function createDataset({ name, sourceFilename = null, uploadedBy = null, rowCount = 0, status = "active", notes = null }) {
  const { data, error } = await supabase
    .from("datasets")
    .insert({
      name,
      source_filename: sourceFilename,
      uploaded_by: uploadedBy,
      row_count: rowCount,
      status,
      notes,
    })
    .select("*")
    .single();

  if (error) {
    console.error("createDataset error:", error.message);
    throw error;
  }

  return data;
}

async function readAllRows(datasetId = null) {
  let query = supabase
    .from("leads")
    .select("*");

  if (datasetId === "initial") {
    query = query.is("dataset_id", null);
  } else if (datasetId) {
    query = query.eq("dataset_id", datasetId);
  }

  const { data, error } = await query.order("created_at", { ascending: true });

  if (error) {
    console.error("readAllRows error:", error.message);
    throw error;
  }

  const rows = (data || []).map(row => ({
    ...row,
    // Keep id as the primary identifier for frontend
    call_attempts: row.call_attempts ?? 0,
  }));

  console.log(`readAllRows: Returning ${rows.length} rows${datasetId ? ` for dataset ${datasetId}` : ""}`);
  return { headers: LEAD_HEADERS, rows };
}

async function readRow(id) {
  // id can be either the Supabase UUID or lead_id
  let query = supabase.from("leads").select("*");

  // Check if it's a UUID format or lead_id format
  if (typeof id === "string" && id.startsWith("lead_")) {
    query = query.eq("lead_id", id);
  } else {
    query = query.eq("id", id);
  }

  const { data, error } = await query.single();

  if (error) {
    console.error("readRow error:", error.message);
    throw error;
  }

  return data;
}

async function updateRow(id, updates) {
  // id can be either the Supabase UUID or lead_id
  let query = supabase.from("leads");

  // Remove any fields that shouldn't be updated
  const cleanUpdates = { ...updates };
  delete cleanUpdates.id;
  delete cleanUpdates.created_at;

  // Check if it's a UUID format or lead_id format
  if (typeof id === "string" && id.startsWith("lead_")) {
    query = query.update(cleanUpdates).eq("lead_id", id);
  } else {
    query = query.update(cleanUpdates).eq("id", id);
  }

  const { error } = await query;

  if (error) {
    console.error("updateRow error:", error.message);
    throw error;
  }
}

async function appendRow(rowData) {
  const sourceRowNumber = rowData.source_row_number == null || rowData.source_row_number === ""
    ? null
    : parseInt(rowData.source_row_number, 10);

  // Auto-generate IDs if not provided
  const insertData = {
    ...rowData,
    lead_id: rowData.lead_id || generateId("lead"),
    property_id: rowData.property_id || generateId("prop"),
    call_status: rowData.call_status || "queued",
    call_attempts: parseInt(rowData.call_attempts, 10) || 0,
    dataset_id: rowData.dataset_id || null,
    source_row_number: Number.isFinite(sourceRowNumber) ? sourceRowNumber : null,
  };

  const { data, error } = await supabase
    .from("leads")
    .insert(insertData)
    .select()
    .single();

  if (error) {
    console.error("appendRow error:", error.message);
    throw error;
  }

  return { id: data.id, lead_id: data.lead_id, headers: LEAD_HEADERS };
}

async function getHeaders() {
  return LEAD_HEADERS;
}

async function deleteRow(id) {
  let query = supabase.from("leads");

  // Check if it's a UUID format or lead_id format
  if (typeof id === "string" && id.startsWith("lead_")) {
    query = query.delete().eq("lead_id", id);
  } else {
    query = query.delete().eq("id", id);
  }

  const { error } = await query;

  if (error) {
    console.error("deleteRow error:", error.message);
    throw error;
  }
}

async function deleteRowsBulk(ids) {
  if (!ids || ids.length === 0) {
    return;
  }

  const { error } = await supabase
    .from("leads")
    .delete()
    .in("id", ids);

  if (error) {
    console.error("deleteRowsBulk error:", error.message);
    throw error;
  }
}

async function updateRowsBulk(ids, updates) {
  if (!ids || ids.length === 0) {
    return;
  }

  const cleanUpdates = { ...updates };
  delete cleanUpdates.id;
  delete cleanUpdates.created_at;

  const { error } = await supabase
    .from("leads")
    .update(cleanUpdates)
    .in("id", ids);

  if (error) {
    console.error("updateRowsBulk error:", error.message);
    throw error;
  }
}

async function deleteDatasetById(datasetId) {
  const trimmedId = String(datasetId || "").trim();
  if (!trimmedId) {
    throw new Error("Missing dataset id");
  }

  const { data: existingDataset, error: existingDatasetError } = await supabase
    .from("datasets")
    .select("id,name")
    .eq("id", trimmedId)
    .single();

  if (existingDatasetError) {
    throw existingDatasetError;
  }

  const { error: deleteLeadsError } = await supabase
    .from("leads")
    .delete()
    .eq("dataset_id", trimmedId);
  if (deleteLeadsError) {
    throw deleteLeadsError;
  }

  const { error: deleteDatasetError } = await supabase
    .from("datasets")
    .delete()
    .eq("id", trimmedId);
  if (deleteDatasetError) {
    throw deleteDatasetError;
  }

  return existingDataset;
}

async function updateRowsBatch(updates) {
  // updates is an array of { id, values }
  for (const { id, values } of updates) {
    await updateRow(id, values);
  }
}

// Helper to find lead by bolna_execution_id
async function findLeadByBolnaExecutionId(executionId) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("bolna_execution_id", executionId)
    .single();

  if (error && error.code !== "PGRST116") { // PGRST116 = no rows returned
    console.error("findLeadByBolnaExecutionId error:", error.message);
  }

  return data || null;
}

// Helper to find the most likely active Bolna lead by phone when webhook context is missing
async function findLikelyActiveBolnaLeadByPhone(phoneE164) {
  if (!phoneE164) return null;

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("phone_e164", phoneE164)
    .eq("call_provider", "bolna")
    .order("last_call_at", { ascending: false })
    .limit(3);

  if (error) {
    console.error("findLikelyActiveBolnaLeadByPhone error:", error.message);
    return null;
  }

  const leads = data || [];
  if (leads.length === 0) return null;

  // Prefer currently active lead to avoid linking a new execution to an old completed call.
  const active = leads.find((l) => String(l.call_status || "").toLowerCase() === "calling");
  return active || leads[0] || null;
}

function buildBolnaWebhookEventSnapshot(payload, receivedAtIso) {
  const telephonyData = payload?.telephony_data || {};
  return {
    received_at: receivedAtIso,
    execution_id: payload?.execution_id || payload?.id || null,
    batch_id: payload?.batch_id || null,
    status: payload?.status || null,
    conversation_time: payload?.conversation_time ?? payload?.conversation_duration ?? null,
    answered_by_voice_mail: Boolean(payload?.answered_by_voice_mail),
    to_number: telephonyData?.to_number || null,
    from_number: telephonyData?.from_number || null,
    hangup_reason: telephonyData?.hangup_reason || null,
    provider_outcome: payload?.outcome || payload?.call_outcome || payload?.disposition_tag || null,
  };
}

async function upsertBolnaCallTracking({
  executionId,
  lead,
  leadId,
  propertyId,
  phoneE164,
  status,
  outcome = null,
  nextAction = null,
  durationSec = null,
  transcript = "",
  recordingUrl = "",
  providerOutcomeRaw = null,
  providerOutcomeNormalized = null,
  outcomeSource = null,
  payload,
  isTerminal,
}) {
  const nowIso = new Date().toISOString();
  const eventSnapshot = buildBolnaWebhookEventSnapshot(payload, nowIso);
  const trimmedTranscript = typeof transcript === "string" ? transcript.slice(0, 50000) : "";

  if (!executionId) {
    // If execution_id is missing we cannot conflict-upsert reliably; still persist event.
    await supabase.from("calls").insert({
      bolna_execution_id: null,
      lead_id: leadId || (lead?.lead_id) || null,
      property_id: propertyId || (lead?.property_id) || null,
      phone_e164: phoneE164 || (lead?.phone_e164) || null,
      call_provider: "bolna",
      status,
      outcome,
      next_action: nextAction,
      duration_sec: durationSec != null ? Math.round(Number(durationSec)) : null,
      transcript: trimmedTranscript,
      recording_url: recordingUrl || null,
      started_at: nowIso,
      ended_at: isTerminal ? nowIso : null,
      raw_webhook: {
        last_event: payload,
        bolna_events: [eventSnapshot],
        provider_outcome_raw: providerOutcomeRaw,
        provider_outcome_normalized: providerOutcomeNormalized,
        outcome_source: outcomeSource,
      },
    });
    return;
  }

  const { data: existing, error: existingErr } = await supabase
    .from("calls")
    .select("raw_webhook, started_at, attempt, lead_id, property_id, phone_e164")
    .eq("bolna_execution_id", executionId)
    .maybeSingle();

  if (existingErr) {
    console.error("upsertBolnaCallTracking read existing error:", existingErr.message);
  }

  const existingRaw = existing?.raw_webhook && typeof existing.raw_webhook === "object" ? existing.raw_webhook : {};
  const existingEvents = Array.isArray(existingRaw.bolna_events) ? existingRaw.bolna_events : [];
  const mergedEvents = [...existingEvents, eventSnapshot].slice(-50);

  await supabase
    .from("calls")
    .upsert(
      {
        bolna_execution_id: executionId,
        lead_id: leadId || existing?.lead_id || (lead?.lead_id) || null,
        property_id: propertyId || existing?.property_id || (lead?.property_id) || null,
        phone_e164: phoneE164 || existing?.phone_e164 || (lead?.phone_e164) || null,
        call_provider: "bolna",
        status,
        outcome,
        next_action: nextAction,
        attempt: existing?.attempt || null,
        duration_sec: durationSec != null ? Math.round(Number(durationSec)) : null,
        transcript: trimmedTranscript,
        recording_url: recordingUrl || null,
        started_at: existing?.started_at || nowIso,
        ended_at: isTerminal ? nowIso : null,
        raw_webhook: {
          ...existingRaw,
          batch_id: payload?.batch_id || existingRaw.batch_id || null,
          last_event: payload,
          bolna_events: mergedEvents,
          provider_outcome_raw: providerOutcomeRaw ?? existingRaw.provider_outcome_raw ?? null,
          provider_outcome_normalized: providerOutcomeNormalized ?? existingRaw.provider_outcome_normalized ?? null,
          outcome_source: outcomeSource ?? existingRaw.outcome_source ?? null,
        },
      },
      { onConflict: "bolna_execution_id" }
    );
}

// -------------------- Ringg AI call helpers --------------------

async function startRinggCall({ phone, name, customArgs }) {
  const callPayload = {
    name: name || "Lead",
    mobile_number: phone,
    agent_id: process.env.RINGG_AGENT_ID,
    from_number_id: process.env.RINGG_FROM_NUMBER_ID,
    custom_args_values: customArgs || {},
  };

  console.log(`Starting Ringg call to ${phone} with agent ${process.env.RINGG_AGENT_ID}`);

  const resp = await fetch("https://prod-api.ringg.ai/ca/api/v0/calling/outbound/individual", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.RINGG_API_KEY,
    },
    body: JSON.stringify(callPayload),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`Ringg API error for ${phone}: ${resp.status} ${txt}`);
    throw new Error(`Ringg start call failed: ${resp.status} ${txt}`);
  }

  const result = await resp.json();
  const callId = result?.data?.["Unique Call ID"] || "";
  console.log(`Ringg call started: call_id=${callId}`);
  return { call_id: callId, raw: result };
}

async function findLeadByRinggCallId(callId) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("ringg_call_id", callId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("findLeadByRinggCallId error:", error.message);
  }
  return data || null;
}

async function findLikelyActiveRinggLeadByPhone(phoneE164) {
  if (!phoneE164) return null;

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("phone_e164", phoneE164)
    .eq("call_provider", "ringg")
    .order("last_call_at", { ascending: false })
    .limit(3);

  if (error) {
    console.error("findLikelyActiveRinggLeadByPhone error:", error.message);
    return null;
  }

  const leads = data || [];
  if (leads.length === 0) return null;
  const active = leads.find((l) => String(l.call_status || "").toLowerCase() === "calling");
  return active || leads[0] || null;
}

function ringgTranscriptToText(transcriptArray) {
  if (typeof transcriptArray === "string") return transcriptArray;
  if (!Array.isArray(transcriptArray)) return "";
  return transcriptArray
    .map((turn) => {
      if (turn.bot) return `bot: ${turn.bot}`;
      if (turn.user) return `user: ${turn.user}`;
      if (turn.agent) return `bot: ${turn.agent}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function upsertRinggCallTracking({
  ringgCallId,
  lead,
  leadId,
  propertyId,
  phoneE164,
  status,
  outcome = null,
  nextAction = null,
  durationSec = null,
  transcript = "",
  recordingUrl = "",
  outcomeSource = null,
  payload,
  isTerminal,
}) {
  const nowIso = new Date().toISOString();
  const eventSnapshot = {
    received_at: nowIso,
    event_type: payload?.event_type || null,
    call_id: ringgCallId,
    status: payload?.status || status,
    call_duration: payload?.call_duration ?? null,
  };
  const trimmedTranscript = typeof transcript === "string" ? transcript.slice(0, 50000) : "";

  if (!ringgCallId) {
    await supabase.from("calls").insert({
      ringg_call_id: null,
      lead_id: leadId || lead?.lead_id || null,
      property_id: propertyId || lead?.property_id || null,
      phone_e164: phoneE164 || lead?.phone_e164 || null,
      call_provider: "ringg",
      status,
      outcome,
      next_action: nextAction,
      duration_sec: durationSec != null ? Math.round(Number(durationSec)) : null,
      transcript: trimmedTranscript,
      recording_url: recordingUrl || null,
      started_at: nowIso,
      ended_at: isTerminal ? nowIso : null,
      raw_webhook: { last_event: payload, ringg_events: [eventSnapshot], outcome_source: outcomeSource },
    });
    return;
  }

  const { data: existing, error: existingErr } = await supabase
    .from("calls")
    .select("raw_webhook, started_at, attempt, lead_id, property_id, phone_e164")
    .eq("ringg_call_id", ringgCallId)
    .maybeSingle();

  if (existingErr) {
    console.error("upsertRinggCallTracking read existing error:", existingErr.message);
  }

  const existingRaw = existing?.raw_webhook && typeof existing.raw_webhook === "object" ? existing.raw_webhook : {};
  const existingEvents = Array.isArray(existingRaw.ringg_events) ? existingRaw.ringg_events : [];
  const mergedEvents = [...existingEvents, eventSnapshot].slice(-50);

  await supabase
    .from("calls")
    .upsert(
      {
        ringg_call_id: ringgCallId,
        lead_id: leadId || existing?.lead_id || lead?.lead_id || null,
        property_id: propertyId || existing?.property_id || lead?.property_id || null,
        phone_e164: phoneE164 || existing?.phone_e164 || lead?.phone_e164 || null,
        call_provider: "ringg",
        status,
        outcome,
        next_action: nextAction,
        attempt: existing?.attempt || null,
        duration_sec: durationSec != null ? Math.round(Number(durationSec)) : null,
        transcript: trimmedTranscript,
        recording_url: recordingUrl || null,
        started_at: existing?.started_at || nowIso,
        ended_at: isTerminal ? nowIso : null,
        raw_webhook: {
          ...existingRaw,
          last_event: payload,
          ringg_events: mergedEvents,
          outcome_source: outcomeSource ?? existingRaw.outcome_source ?? null,
        },
      },
      { onConflict: "ringg_call_id" }
    );
}

// -------------------- Bolna webhook schema --------------------
// Use loose types for nested objects to avoid Zod v4 parse bugs when Bolna sends unexpected shapes
const BolnaWebhookSchema = z.object({
  id: z.string().nullable().optional(),
  execution_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  batch_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  conversation_time: z.number().nullable().optional(),
  total_cost: z.number().nullable().optional(),
  transcript: z.string().nullable().optional(),
  answered_by_voice_mail: z.boolean().nullable().optional(),
  error_message: z.string().nullable().optional(),
  telephony_data: z.record(z.any()).nullable().optional(),
  extracted_data: z.record(z.any()).nullable().optional(),
  context_details: z.record(z.any()).nullable().optional(),
  user_data: z.record(z.any()).nullable().optional(),
}).passthrough();

function hasDisinterestSignal(text = "") {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("not interested") ||
    t.includes("no interest") ||
    t.includes("not looking") ||
    t.includes("don't want") ||
    t.includes("do not want") ||
    t.includes("don't need") ||
    t.includes("do not need") ||
    t.includes("no thanks") ||
    t.includes("not now") ||
    t.includes("not right now") ||
    t.includes("nahi") ||
    t.includes("nahin") ||
    t.includes("nhi")
  );
}

function hasStrongInterestSignal(text = "") {
  const t = String(text || "").toLowerCase();
  if (hasDisinterestSignal(t)) return false;
  return (
    t.includes("expressed interest") ||
    t.includes("interested in learning more") ||
    t.includes("schedule a visit") ||
    t.includes("arrange a visit") ||
    t.includes("coordinate a visit") ||
    t.includes("site visit") ||
    t.includes("book a visit") ||
    t.includes("share details") ||
    t.includes("send details")
  );
}

function normalizeOutcomeLabel(value) {
  const t = String(value || "").trim().toLowerCase();
  if (!t) return null;
  if (["interested"].includes(t)) return "interested";
  if (["not_interested", "not interested", "not-interest", "disinterested"].includes(t)) return "not_interested";
  if (["opt_out", "opt out", "dnc", "do not call"].includes(t)) return "opt_out";
  if (["no_answer", "no answer", "no-answer", "unanswered", "busy"].includes(t)) return "no_answer";
  if (["voicemail", "voice_mail", "voice mail"].includes(t)) return "voicemail";
  if (["human_followup", "human followup", "followup", "follow_up"].includes(t)) return "human_followup";
  return null;
}

function extractBolnaProviderOutcome(payload = {}) {
  const candidates = [
    payload?.outcome,
    payload?.call_outcome,
    payload?.disposition_tag,
    payload?.result?.outcome,
    payload?.analysis?.outcome,
    payload?.extracted_data?.outcome,
    payload?.extracted_data?.call_outcome,
    payload?.extracted_data?.disposition,
    payload?.extracted_data?.lead_status,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function defaultNextActionForOutcome(outcome) {
  switch (outcome) {
    case "opt_out":
    case "not_interested":
      return "none";
    case "no_answer":
    case "voicemail":
      return "call_back_later";
    case "interested":
    case "human_followup":
    default:
      return "human_followup";
  }
}

function classifyOutcome({ answeredBy, summary, transcript, completed, callLength, dispositionTag }) {
  // Use Bland's disposition_tag if available (Bland's own classification)
  if (dispositionTag) {
    const dispositionLower = dispositionTag.toLowerCase();
    
    // Map Bland's disposition tags to our outcomes
    if (dispositionLower === "interested") {
      return { outcome: "interested", next_action: "human_followup" };
    }
    if (dispositionLower === "not_interested" || dispositionLower === "not interested") {
      return { outcome: "not_interested", next_action: "none" };
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

  // Explicit disinterest should never be promoted to interested.
  if (hasDisinterestSignal(text)) {
    return { outcome: "not_interested", next_action: "none" };
  }

  // If there's a conversation, analyze it regardless of answered_by value
  // "unknown" can still mean a human answered, just not detected
  if (hasConversation) {
    // Strong "interested" signals
    if (
      (
        text.includes("agreed") &&
        (text.includes("walkthrough") || text.includes("visit") || text.includes("showing"))
      ) ||
      hasStrongInterestSignal(text)
    ) {
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

// -------------------- Start Bolna batch (Hinglish) --------------------
function buildBolnaBatchCsv(leads) {
  const header = [
    "contact_number",
    "lead_name",
    "phone_e164",
    "property_name",
    "lead_id",
    "property_id",
    "id",
  ];

  const escapeCsv = (value) => {
    const stringValue = String(value ?? "");
    const escaped = stringValue.replace(/"/g, "\"\"");
    return `"${escaped}"`;
  };

  const rows = leads.map((row) => ([
    row.phone_e164 || "",
    row.lead_name || "",
    row.phone_e164 || "",
    row.property_name || "Tulip Monsella",
    row.lead_id || "",
    row.property_id || "",
    row.id || "",
  ]).map(escapeCsv).join(","));

  return [header.join(","), ...rows].join("\n");
}

async function createBolnaBatch({ leads }) {
  const csvContent = buildBolnaBatchCsv(leads);
  const form = new FormData();

  form.append("agent_id", process.env.BOLNA_AGENT_ID);
  form.append("file", new Blob([csvContent], { type: "text/csv" }), "homeseek-bolna-batch.csv");

  const resp = await fetch("https://api.bolna.ai/batches", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
    },
    body: form,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Bolna create batch failed: ${resp.status} ${txt}`);
  }

  const result = await resp.json();
  const batchId = result.batch_id || result.id || result.data?.batch_id || "";
  if (!batchId) {
    throw new Error(`Bolna create batch response missing batch_id: ${JSON.stringify(result).slice(0, 300)}`);
  }

  return { batchId, raw: result };
}

function getBolnaBatchScheduledAt(delaySeconds = BOLNA_BATCH_SCHEDULE_DELAY_SECONDS) {
  const targetDate = new Date(Date.now() + Math.max(Number(delaySeconds) || 0, BOLNA_MIN_SCHEDULE_SECONDS) * 1000);
  // Bolna schedule endpoint currently rejects "Z" suffix in some environments.
  // Send Python fromisoformat-friendly UTC offset (+00:00) without milliseconds.
  return targetDate.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

async function scheduleBolnaBatch({ batchId, scheduledAt }) {
  const trySchedule = async (isoTime) => {
    const form = new FormData();
    form.append("scheduled_at", isoTime);

    const resp = await fetch(`https://api.bolna.ai/batches/${batchId}/schedule`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
      },
      body: form,
    });

    if (!resp.ok) {
      const txt = await resp.text();
      const error = new Error(`Bolna schedule batch failed: ${resp.status} ${txt}`);
      error.status = resp.status;
      error.responseText = txt;
      error.scheduledAt = isoTime;
      throw error;
    }

    const json = await resp.json();
    return { scheduledAt: isoTime, raw: json };
  };

  try {
    return await trySchedule(scheduledAt);
  } catch (err) {
    const message = String(err?.responseText || err?.message || "");
    const isTooSoonError = err?.status === 400 && /atleast 2 minutes in the future/i.test(message);
    const isIsoFormatError = /Invalid isoformat string/i.test(message);
    if (!isTooSoonError && !isIsoFormatError) throw err;

    // Retry once with extra buffer and strict +00:00 format.
    const retryScheduledAt = getBolnaBatchScheduledAt(240);
    console.warn(`Bolna schedule retry with compatible timestamp: ${retryScheduledAt}`);
    return await trySchedule(retryScheduledAt);
  }
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// Serve index.html for root path
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Main leads dashboard page
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"));
});

// --- Auth routes (no auth required) ---
app.get("/auth/me", (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true, user: "anonymous" });
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies[SESSION_COOKIE_NAME]);
  if (session && session.user) return res.json({ ok: true, user: session.user });
  return res.status(401).json({ ok: false, error: "Not logged in" });
});

app.post("/auth/login", (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ ok: false, error: "Auth not configured" });
  if (!LOGIN_PASSWORD) return res.status(400).json({ ok: false, error: "Password login not configured" });
  const username = (req.body?.username || "").trim();
  const password = req.body?.password;
  if (!username || password === undefined || password === null) {
    return res.status(400).json({ ok: false, error: "Username and password required" });
  }
  const key = username.toLowerCase();
  if (key !== LOGIN_USERNAME.toLowerCase() || String(password) !== String(LOGIN_PASSWORD)) {
    return res.status(400).json({ ok: false, error: "Invalid username or password" });
  }
  const payload = { user: key, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
  res.status(200).json({ ok: true, message: "Logged in" });
});

app.post("/auth/request-otp", async (req, res) => {
  console.log("POST /auth/request-otp received", { username: req.body?.username });
  if (!AUTH_ENABLED) return res.status(400).json({ ok: false, error: "Auth not configured" });
  const username = (req.body?.username || "").trim();
  if (!username) return res.status(400).json({ ok: false, error: "Username required" });
  const key = username.toLowerCase();
  const valid = key === LOGIN_USERNAME.toLowerCase();
  if (valid) {
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + OTP_EXPIRY_MS;
    let atLeastOneSent = false;
    for (const email of LOGIN_EMAILS) {
      try {
        await sendOtpEmail(email, otp);
        atLeastOneSent = true;
      } catch (err) {
        console.error("request-otp send email error to", email, ":", err.message);
      }
    }
    if (!atLeastOneSent) {
      return res.status(500).json({
        ok: false,
        error: "OTP email could not be sent. Check Resend API key, RESEND_FROM, and that your account can send to this address. See server logs for details.",
      });
    }
    const attemptId = await logLoginAttempt({ username: key, email_sent: true });
    otpStore.set(key, { otp, expiresAt, email: LOGIN_EMAILS[0], attemptId });
  } else {
    await logLoginAttempt({ username: key, email_sent: false });
  }
  res.status(200).json({ ok: true, message: "If this username is registered, you'll receive an OTP at the associated email." });
});

app.post("/auth/verify-otp", async (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ ok: false, error: "Auth not configured" });
  const username = (req.body?.username || "").trim();
  const otp = (req.body?.otp || "").trim();
  if (!username || !otp) return res.status(400).json({ ok: false, error: "Username and OTP required" });
  const key = username.toLowerCase();
  const stored = otpStore.get(key);
  if (!stored) return res.status(400).json({ ok: false, error: "Invalid or expired OTP. Request a new one." });
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(key);
    return res.status(400).json({ ok: false, error: "OTP expired. Request a new one." });
  }
  if (stored.otp !== otp) return res.status(400).json({ ok: false, error: "Invalid OTP." });
  otpStore.delete(key);
  if (stored.attemptId) {
    await supabase.from("login_attempts").update({ verified: true }).eq("id", stored.attemptId);
  }
  const payload = { user: key, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
  res.json({ ok: true, message: "Logged in" });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// Dataset library endpoint for landing-page tiles
app.get("/datasets", async (req, res) => {
  try {
    const [{ data: datasets, error: datasetError }, { data: leadRows, error: leadError }] = await Promise.all([
      supabase
        .from("datasets")
        .select("id,name,source_filename,uploaded_by,uploaded_at,row_count,status,notes,created_at")
        .order("uploaded_at", { ascending: false }),
      supabase.from("leads").select("dataset_id"),
    ]);

    if (datasetError) throw datasetError;
    if (leadError) throw leadError;

    const datasetCountMap = new Map();
    let initialDataCount = 0;

    for (const row of leadRows || []) {
      if (!row.dataset_id) {
        initialDataCount++;
        continue;
      }
      datasetCountMap.set(row.dataset_id, (datasetCountMap.get(row.dataset_id) || 0) + 1);
    }

    const normalizedDatasets = (datasets || []).map((d) => ({
      ...d,
      row_count: datasetCountMap.get(d.id) || 0,
    }));

    return res.json({
      ok: true,
      initial_data: {
        id: "initial",
        name: "Initial Data",
        row_count: initialDataCount,
      },
      datasets: normalizedDatasets,
    });
  } catch (err) {
    console.error("get datasets failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * DELETE /datasets/:id
 * Deletes a dataset and all leads linked to it.
 */
app.delete("/datasets/:id", async (req, res) => {
  try {
    const datasetId = String(req.params?.id || "").trim();
    if (!datasetId) {
      return res.status(400).json({ ok: false, error: "Missing dataset id" });
    }
    if (datasetId === "initial") {
      return res.status(400).json({ ok: false, error: "Initial Data cannot be deleted as a dataset" });
    }

    const deletedDataset = await deleteDatasetById(datasetId);
    console.log(`DELETE /datasets/${datasetId} - deleted dataset "${deletedDataset.name}"`);
    return res.json({
      ok: true,
      id: datasetId,
      dataset_name: deletedDataset.name,
      message: "Dataset deleted successfully",
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/0 rows|No rows|not found/i.test(msg)) {
      return res.status(404).json({ ok: false, error: "Dataset not found" });
    }
    console.error("delete dataset failed:", err);
    return res.status(500).json({ ok: false, error: msg });
  }
});

// Auth is only used for the login screen (frontend shows app after login).
// No server-side auth on API routes — /rows, /trigger-call, /run-dialer, etc. are open once you're in.

/**
 * POST /trigger-call
 * Triggers a call for a specific lead via Bolna or Ringg.
 * Input: { "id": "uuid-here", "provider": "bolna" | "ringg" }
 */
app.post("/trigger-call", async (req, res) => {
  try {
    console.log("trigger-call received body:", JSON.stringify(req.body));
    const { id, provider = "bolna" } = req.body;

    const VALID_PROVIDERS = ["bolna", "ringg"];
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ ok: false, error: `Invalid provider. Supported: ${VALID_PROVIDERS.join(", ")}` });
    }

    if (provider === "ringg" && !RINGG_ENABLED) {
      return res.status(400).json({ ok: false, error: "Ringg provider not configured. Set RINGG_API_KEY, RINGG_AGENT_ID, RINGG_FROM_NUMBER_ID." });
    }

    if (!id) {
      return res.status(400).json({ ok: false, error: "Missing id. Must provide lead id" });
    }

    // Read the specific lead
    const row = await readRow(id);

    if (!row) {
      return res.status(404).json({ ok: false, error: "Lead not found" });
    }

    if (!row.phone_e164 || !row.phone_e164.trim().startsWith("+")) {
      return res.status(400).json({ ok: false, error: "Lead missing valid phone_e164" });
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

    const leadId = row.id;
    const attempts = Number(row.call_attempts || 0) + 1;

    // Mark as calling with provider info
    await updateRow(leadId, {
      call_status: "calling",
      call_attempts: attempts,
      last_call_at: new Date().toISOString(),
      call_provider: provider, // Track which provider is being used
    });

    const startedAt = new Date().toISOString();

    try {
      const contextVars = {
        lead_name: row.lead_name || "",
        phone_e164: row.phone_e164,
        property_name: row.property_name || "Tulip Monsella",
        lead_id: row.lead_id || "",
        property_id: row.property_id || "",
        id: leadId,
      };

      let callId = "";

      if (provider === "ringg") {
        const ringgResp = await startRinggCall({
          phone: row.phone_e164,
          name: row.lead_name || "Lead",
          customArgs: contextVars,
        });

        callId = ringgResp.call_id;
        console.log(`Ringg: saving call_id=${callId} to lead ${leadId}`);
        await updateRow(leadId, { ringg_call_id: callId });

        await supabase.from("calls").insert({
          lead_id: row.lead_id || null,
          property_id: row.property_id || null,
          phone_e164: row.phone_e164,
          ringg_call_id: callId || null,
          call_provider: "ringg",
          status: "calling",
          outcome: null,
          next_action: null,
          attempt: attempts,
          started_at: startedAt,
          raw_webhook: { started_response: ringgResp.raw },
        });
      } else {
        const bolnaResp = await startBolnaCall({
          phone: row.phone_e164,
          userData: contextVars,
        });

        callId = bolnaResp.execution_id || "";
        console.log(`Bolna: saving execution_id=${callId} to lead ${leadId}`);
        await updateRow(leadId, { bolna_execution_id: callId });

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
      }

      return res.json({
        ok: true,
        call_id: callId,
        provider,
        id: leadId,
        message: `Call started successfully via ${provider}`,
      });
    } catch (err) {
      console.error(`Trigger call error (${provider}):`, err);

      await updateRow(leadId, {
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
    const datasetIdRaw = typeof req.query?.dataset_id === "string" ? req.query.dataset_id.trim() : "";
    const datasetId = datasetIdRaw || null;
    console.log(`GET /rows - fetching rows${datasetId ? ` for dataset ${datasetId}` : ""}...`);
    const { headers, rows } = await readAllRows(datasetId);
    return res.json({ ok: true, dataset_id: datasetId, headers: headers || [], rows: rows || [] });
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
 * Adds a new lead to the database.
 * Input: { "data": { "phone_e164": "+1234567890", "property_address": "...", ... } }
 * Auto-generates: lead_id, property_id, call_status, call_attempts
 */
app.post("/add-row", async (req, res) => {
  try {
    const { data } = req.body;

    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid data. Expected { data: { ... } }" });
    }

    // appendRow handles ID generation and defaults
    const result = await appendRow(data);

    console.log(`POST /add-row - added lead id: ${result.id}, lead_id: ${result.lead_id}`);

    return res.json({
      ok: true,
      message: "Lead added successfully",
      id: result.id,
      lead_id: result.lead_id,
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

function normalizeCsvHeader(header) {
  return String(header || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function formatCsvHeaders(headers = []) {
  const cleaned = headers
    .map(h => String(h || "").trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(", ") : "(none)";
}

function buildNormalizedCsvRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row || {})) {
    const normalizedKey = normalizeCsvHeader(key);
    if (!normalizedKey) continue;
    normalized[normalizedKey] = value;
  }
  return normalized;
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

    // Parse CSV and validate header row first so we can return precise errors.
    const csvContent = req.file.buffer.toString("utf8");
    let rawRows;
    let records;

    try {
      rawRows = parse(csvContent, {
        columns: false,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true, // Allow extra columns
        bom: true,
      });
    } catch (parseError) {
      console.error("CSV header parse error:", parseError);
      return res.status(400).json({
        ok: false,
        error: `Invalid CSV format: ${parseError.message}`,
      });
    }

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return res.status(400).json({ ok: false, error: "CSV file is empty" });
    }

    const receivedHeaders = Array.isArray(rawRows[0]) ? rawRows[0].map(h => String(h || "").trim()) : [];
    const normalizedHeaders = new Set(receivedHeaders.map(normalizeCsvHeader).filter(Boolean));

    if (normalizedHeaders.size === 0) {
      return res.status(400).json({
        ok: false,
        error: "CSV header row is empty. Expected headers like: Name, Mobile Number, Email, Date, Interested in.",
      });
    }

    const mobileHeaderAliases = ["mobile number", "mobile", "phone", "phone number"];
    const hasMobileHeader = mobileHeaderAliases.some(alias => normalizedHeaders.has(alias));
    if (!hasMobileHeader) {
      return res.status(400).json({
        ok: false,
        error: `CSV is missing required phone header. Expected one of: Mobile Number, Mobile, Phone, Phone Number. Received: ${formatCsvHeaders(receivedHeaders)}.`,
      });
    }

    try {
      records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true, // Allow extra columns
        bom: true,
      });
    } catch (parseError) {
      console.error("CSV parse error:", parseError);
      return res.status(400).json({ ok: false, error: `Invalid CSV format: ${parseError.message}` });
    }

    if (records.length === 0) {
      return res.status(400).json({ ok: false, error: "CSV file is empty or has no valid rows" });
    }

    const rawDatasetName = String(req.body?.dataset_name || "").trim();
    const sourceFilename = req.file.originalname || null;
    const fallbackName = sourceFilename ? sourceFilename.replace(/\.[^.]+$/, "") : `Dataset ${new Date().toISOString().slice(0, 10)}`;
    const datasetName = rawDatasetName || fallbackName;

    const dataset = await createDataset({
      name: datasetName,
      sourceFilename,
      uploadedBy: LOGIN_USERNAME || "system",
      rowCount: 0,
      status: "active",
    });

    let inserted = 0;
    let skipped = 0;
    const errors = [];

    // Process each row
    for (let i = 0; i < records.length; i++) {
      const row = buildNormalizedCsvRow(records[i]);

      // Extract required fields using normalized header names.
      const name = row["name"] || "";
      const mobileNumber = row["mobile number"] || row["mobile"] || row["phone"] || row["phone number"] || "";
      const email = row["email"] || "";
      // Date and Interested in are not stored, but we read them for validation if needed
      
      // Normalize phone number
      const phoneE164 = normalizePhoneForIndia(mobileNumber);
      
      if (!phoneE164) {
        skipped++;
        errors.push(`Row ${i + 2}: Invalid phone number "${mobileNumber}"`);
        continue;
      }

      // Build row data for Supabase
      const rowData = {
        lead_name: name.trim() || "",
        phone_e164: phoneE164,
        email: email.trim() || "",
        call_status: "queued",
        call_attempts: 0,
        dataset_id: dataset.id,
        source_row_number: i + 2,
      };

      try {
        await appendRow(rowData);
        inserted++;
      } catch (appendError) {
        skipped++;
        errors.push(`Row ${i + 2}: Failed to insert - ${appendError.message}`);
        console.error(`Failed to insert row ${i + 2}:`, appendError);
      }
    }

    await supabase.from("datasets").update({ row_count: inserted }).eq("id", dataset.id);

    console.log(`POST /upload-csv - dataset=${dataset.id}, inserted=${inserted}, skipped=${skipped}`);

    return res.json({
      ok: true,
      dataset_id: dataset.id,
      dataset_name: dataset.name,
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
 * Updates an existing lead in the database.
 * Input: { "id": "uuid-here", "data": { "phone_e164": "+1234567890", ... } }
 */
app.put("/update-row", async (req, res) => {
  try {
    const { id, data } = req.body;

    if (!id) {
      return res.status(400).json({ ok: false, error: "Missing id" });
    }

    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid data. Expected { data: { ... } }" });
    }

    // Update the lead with provided data
    await updateRow(id, data);

    console.log(`PUT /update-row - updated lead ${id}`);

    return res.json({
      ok: true,
      message: "Lead updated successfully",
      id,
    });
  } catch (err) {
    console.error("update-row failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * DELETE /delete-row
 * Deletes a lead from the database.
 * Input: { "id": "uuid-here" }
 */
app.delete("/delete-row", async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ ok: false, error: "Missing id" });
    }

    await deleteRow(id);

    console.log(`DELETE /delete-row - deleted lead ${id}`);

    return res.json({
      ok: true,
      message: "Lead deleted successfully",
      id,
    });
  } catch (err) {
    console.error("delete-row failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * PUT /update-rows-bulk
 * Updates multiple leads in the database.
 * Input: { "ids": ["uuid-1", "uuid-2", ...], "data": { "call_status": "queued", ... } }
 */
app.put("/update-rows-bulk", async (req, res) => {
  try {
    const { ids, data } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid ids. Must be a non-empty array" });
    }

    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid data. Expected { data: { ... } }" });
    }

    // Only allow updating call_status for bulk operations (safety)
    const allowedFields = ["call_status"];
    const safeData = {};
    for (const key of allowedFields) {
      if (data[key] !== undefined) {
        safeData[key] = data[key];
      }
    }
    if (Object.keys(safeData).length === 0) {
      return res.status(400).json({ ok: false, error: "No allowed fields to update. Use data: { call_status: 'queued' | 'calling' | 'completed' | 'failed' }" });
    }

    await updateRowsBulk(ids, safeData);

    console.log(`PUT /update-rows-bulk - updated ${ids.length} leads`);

    return res.json({
      ok: true,
      message: `${ids.length} lead(s) updated successfully`,
      updated_count: ids.length,
    });
  } catch (err) {
    console.error("update-rows-bulk failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * DELETE /delete-rows-bulk
 * Deletes multiple leads from the database.
 * Input: { "ids": ["uuid-1", "uuid-2", ...] }
 */
app.delete("/delete-rows-bulk", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid ids. Must be a non-empty array" });
    }

    await deleteRowsBulk(ids);

    console.log(`DELETE /delete-rows-bulk - deleted ${ids.length} leads`);

    return res.json({
      ok: true,
      message: `${ids.length} lead(s) deleted successfully`,
      deleted_count: ids.length,
    });
  } catch (err) {
    console.error("delete-rows-bulk failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * POST /run-dialer
 * Bulk Dialing with Bolna (Hinglish) only.
 * Input: { "limit": 25, "dataset_id": "optional uuid" }
 *   - limit: max leads to call (default 5, max 50)
 */
app.post("/run-dialer", async (req, res) => {
  try {
    const { limit = 5, dataset_id = null } = req.body;
    const maxRows = Math.min(Math.max(Number(limit), 1), 50);

    const { rows } = await readAllRows(dataset_id || null);

    // Filter leads that are ready to call
    const queued = rows
      .filter(r => String(r.call_status || "").toLowerCase() === "queued")
      .filter(r => Number(r.call_attempts || 0) < 3)
      .filter(r => String(r.phone_e164 || "").trim().startsWith("+"))
      .slice(0, maxRows);

    if (queued.length === 0) {
      return res.json({ ok: true, processed: 0, message: "No queued leads found" });
    }

    console.log(`Bulk dialing: ${queued.length} leads via Bolna`);

    const startedAt = new Date().toISOString();
    let bolnaSuccessCount = 0;
    let bolnaBatchId = null;

    // Use Bolna Batch API for bulk outbound calls.
    console.log(`Starting Bolna batch for ${queued.length} leads...`);

    for (const row of queued) {
      const attempts = Number(row.call_attempts || 0) + 1;
      await updateRow(row.id, {
        call_status: "calling",
        call_attempts: attempts,
        last_call_at: startedAt,
        call_provider: "bolna",
      });
    }

    try {
      const created = await createBolnaBatch({ leads: queued });
      bolnaBatchId = created.batchId;
      const bolnaScheduledAt = getBolnaBatchScheduledAt();
      const scheduleResult = await scheduleBolnaBatch({ batchId: bolnaBatchId, scheduledAt: bolnaScheduledAt });

      for (const row of queued) {
        const attempts = Number(row.call_attempts || 0) + 1;
        await supabase.from("calls").insert({
          lead_id: row.lead_id || null,
          property_id: row.property_id || null,
          phone_e164: row.phone_e164,
          bolna_execution_id: null,
          call_provider: "bolna",
          status: "calling",
          outcome: null,
          next_action: null,
          attempt: attempts,
          started_at: startedAt,
          raw_webhook: {
            bolna_batch_id: bolnaBatchId,
            bolna_scheduled_at: scheduleResult.scheduledAt,
            batch_create_response: created.raw,
            batch_schedule_response: scheduleResult.raw,
          },
        });
      }

      bolnaSuccessCount = queued.length;
    } catch (bolnaBatchErr) {
      console.error("Bolna batch failed:", bolnaBatchErr);

      for (const row of queued) {
        await updateRow(row.id, {
          call_status: "failed",
          notes: `Bolna batch failed: ${String(bolnaBatchErr.message || bolnaBatchErr)}`,
        });
      }
    }

    return res.json({
      ok: true,
      processed: queued.length,
      bolna_calls: bolnaSuccessCount,
      bolna_batch_id: bolnaBatchId,
      message: `Started ${bolnaSuccessCount} Bolna (Hinglish) calls`
    });

  } catch (err) {
    console.error("run-dialer failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Bolna sends a webhook on every status change (initiated → ringing → in-progress → call-disconnected → completed).
// Only terminal statuses represent the final outcome; transient statuses must not update lead/notes/outcome.
const BOLNA_TERMINAL_STATUSES = ["completed", "call-disconnected", "no-answer", "busy", "failed", "canceled", "balance-low"];

/**
 * POST /webhooks/bolna
 * Bolna sends call status updates here. We only update lead, notes, and outcome on terminal status.
 */
app.post("/webhooks/bolna", async (req, res) => {
  try {
    // Skip Zod validation - use raw body with safe property access
    const payload = req.body || {};

    console.log("Bolna webhook received:", JSON.stringify(payload).slice(0, 500));

    // Extract fields
    const executionId = payload.execution_id || payload.id || "";
    const status = payload.status || "unknown";
    const transcript = payload.transcript || "";
    const telephonyData = payload.telephony_data || {};
    const durationSec = telephonyData.duration ?? payload.conversation_time ?? payload.conversation_duration ?? null;
    const recordingUrl = telephonyData.recording_url || "";
    const answeredByVoicemail = payload.answered_by_voice_mail || false;
    const hangupReason = telephonyData.hangup_reason || "";
    const providerOutcomeRaw = extractBolnaProviderOutcome(payload);
    const providerOutcomeNormalized = normalizeOutcomeLabel(providerOutcomeRaw);

    // Extract context_details which contains our user_data variables
    const contextDetails = payload.context_details || payload.user_data || {};
    const leadId = contextDetails.lead_id || "";
    const propertyId = contextDetails.property_id || "";
    const supabaseId = contextDetails.id || null; // Supabase UUID
    const phoneE164 = telephonyData.to_number || contextDetails.phone_e164 || "";
    const batchId = payload.batch_id || "";

    const isTerminal = BOLNA_TERMINAL_STATUSES.includes(status);

    // Find lead by id from context, or by bolna_execution_id
    let lead = null;
    if (supabaseId) {
      lead = await readRow(supabaseId).catch(() => null);
    }
    if (!lead && executionId) {
      lead = await findLeadByBolnaExecutionId(executionId);
    }
    if (!lead && leadId) {
      lead = await readRow(leadId).catch(() => null);
    }
    if (!lead && phoneE164) {
      lead = await findLikelyActiveBolnaLeadByPhone(phoneE164);
    }

    if (!lead) {
      console.warn(`Bolna webhook: no lead found (execution_id=${executionId}, batch_id=${batchId}, phone=${phoneE164})`);
    } else if (executionId && !lead.bolna_execution_id) {
      // Persist execution_id as early as possible to improve future webhook correlation.
      await updateRow(lead.id, { bolna_execution_id: executionId });
    }

    // Map Bolna status to answered_by for classifyOutcome
    let answeredBy = "unknown";
    if (answeredByVoicemail) {
      answeredBy = "voicemail";
    } else if (status === "completed") {
      answeredBy = "human";
    } else if (status === "no-answer") {
      answeredBy = "no_answer";
    }

    // Use classifyOutcome function
    const { outcome, next_action } = classifyOutcome({
      answeredBy,
      summary: "",
      transcript,
      completed: status === "completed",
      callLength: durationSec,
      dispositionTag: null,
    });

    // Override outcome based on Bolna-specific status
    let finalOutcome = outcome;
    let finalNextAction = next_action;
    let outcomeSource = "local_classifier";
    const bolnaText = String(transcript || "").toLowerCase();

    if (status === "no-answer" || status === "busy") {
      finalOutcome = "no_answer";
      finalNextAction = "call_back_later";
      outcomeSource = "status_mapping";
    } else if (answeredByVoicemail) {
      finalOutcome = "voicemail";
      finalNextAction = "call_back_later";
      outcomeSource = "status_mapping";
    } else if ((status === "completed" || status === "call-disconnected") && providerOutcomeNormalized) {
      // Trust provider outcome when present, but keep hard safety override below.
      finalOutcome = providerOutcomeNormalized;
      finalNextAction = defaultNextActionForOutcome(providerOutcomeNormalized);
      outcomeSource = "provider_outcome";
    } else if ((status === "completed" || status === "call-disconnected") && transcript && finalOutcome === "human_followup") {
      if (hasDisinterestSignal(bolnaText)) {
        finalOutcome = "not_interested";
        finalNextAction = "none";
        outcomeSource = "disinterest_signal";
      } else if (hasStrongInterestSignal(bolnaText)) {
        finalOutcome = "interested";
        finalNextAction = "human_followup";
        outcomeSource = "interest_signal";
      }
    }

    // Hard guardrail: explicit disinterest in transcript always wins.
    if ((status === "completed" || status === "call-disconnected") && hasDisinterestSignal(bolnaText)) {
      finalOutcome = "not_interested";
      finalNextAction = "none";
      outcomeSource = providerOutcomeNormalized === "interested"
        ? "disinterest_override_provider_interested"
        : "disinterest_signal";
    }

    // Determine call_status based on outcome
    const callStatusMap = {
      "opt_out": "opt_out",
      "not_interested": "completed",
      "no_answer": "no_answer",
      "voicemail": "voicemail",
      "interested": "completed",
      "human_followup": "completed",
    };
    const callStatus = callStatusMap[finalOutcome] || "completed";

    console.log(
      `Bolna webhook: execution_id=${executionId}, status=${status}, terminal=${isTerminal}, provider_outcome=${providerOutcomeRaw || "none"}, normalized_provider_outcome=${providerOutcomeNormalized || "none"}, final_outcome=${finalOutcome}, source=${outcomeSource}`
    );

    // Track every webhook event in calls table (transient + terminal).
    await upsertBolnaCallTracking({
      executionId,
      lead,
      leadId,
      propertyId,
      phoneE164,
      status,
      outcome: isTerminal ? finalOutcome : null,
      nextAction: isTerminal ? finalNextAction : null,
      durationSec,
      transcript,
      recordingUrl,
      providerOutcomeRaw,
      providerOutcomeNormalized,
      outcomeSource,
      payload: req.body,
      isTerminal,
    });

    // Update lead on every status with safe minimal fields;
    // only set final outcome/action for terminal statuses.
    if (lead) {
      const leadUpdate = {
        bolna_execution_id: executionId || lead.bolna_execution_id || null,
        call_provider: "bolna",
        last_call_at: new Date().toISOString(),
      };

      if (isTerminal) {
        leadUpdate.call_status = callStatus;
        leadUpdate.outcome = finalOutcome;
        leadUpdate.next_action = finalNextAction;
        leadUpdate.recording_url = recordingUrl;
        leadUpdate.transcript = transcript;
        leadUpdate.notes = `Bolna call - ${hangupReason || status}`;
      } else {
        // Keep UI and tracking in sync for in-flight statuses.
        leadUpdate.call_status = "calling";
        leadUpdate.notes = `Bolna in-progress - ${status}`;
      }

      await updateRow(lead.id, leadUpdate);
    }

    // WhatsApp Hot Lead Alert (only on terminal with interested)
    if (isTerminal && finalOutcome === "interested" && lead) {
      sendWhatsAppHotLeadAlert({
        leadName: lead.lead_name || contextDetails.lead_name || "",
        phoneE164: telephonyData.to_number || lead.phone_e164 || "",
        propertyName: lead.property_name || contextDetails.property_name || "Tulip Monsella",
        callSummary: `Bolna Hinglish call - Lead showed interest. Duration: ${durationSec ?? 0}s`,
      });
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Bolna webhook error:", err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------- Ringg AI Webhook --------------------
// Ringg sends separate event types: call_started, call_completed, recording_completed,
// platform_analysis_completed, client_analysis_completed.
// We treat call_completed as terminal and use platform/client analysis to enrich.
const RINGG_TERMINAL_EVENT_TYPES = ["call_completed"];

app.post("/webhooks/ringg", async (req, res) => {
  try {
    const payload = req.body || {};
    console.log("Ringg webhook received:", JSON.stringify(payload).slice(0, 500));

    const eventType = payload.event_type || "";
    const ringgCallId = payload.call_id || "";
    const status = payload.status || eventType;
    const customArgs = payload.custom_args_values || {};
    const supabaseId = customArgs.id || null;
    const leadId = customArgs.lead_id || "";
    const propertyId = customArgs.property_id || "";
    const phoneE164 = payload.to_number || customArgs.phone_e164 || "";
    const durationSec = payload.call_duration ?? null;
    const recordingUrl = payload.recording_url || "";
    const rawTranscript = payload.transcript;
    const transcript = ringgTranscriptToText(rawTranscript);

    const isTerminal = RINGG_TERMINAL_EVENT_TYPES.includes(eventType);
    const isAnalysis = eventType === "platform_analysis_completed" || eventType === "client_analysis_completed";

    // --- Find lead ---
    let lead = null;
    if (supabaseId) lead = await readRow(supabaseId).catch(() => null);
    if (!lead && ringgCallId) lead = await findLeadByRinggCallId(ringgCallId);
    if (!lead && leadId) lead = await readRow(leadId).catch(() => null);
    if (!lead && phoneE164) lead = await findLikelyActiveRinggLeadByPhone(phoneE164);

    if (!lead) {
      console.warn(`Ringg webhook: no lead found (call_id=${ringgCallId}, phone=${phoneE164})`);
    } else if (ringgCallId && !lead.ringg_call_id) {
      await updateRow(lead.id, { ringg_call_id: ringgCallId });
    }

    // --- Non-terminal: just track and ack ---
    if (!isTerminal && !isAnalysis) {
      if (lead) {
        await updateRow(lead.id, {
          ringg_call_id: ringgCallId || lead.ringg_call_id || null,
          call_provider: "ringg",
          call_status: "calling",
          last_call_at: new Date().toISOString(),
          notes: `Ringg in-progress - ${eventType}`,
        });
      }
      return res.status(200).json({ received: true });
    }

    // --- Analysis events: enrich existing call data ---
    if (isAnalysis) {
      const analysisData = payload.analysis_data || {};
      const classification = analysisData.classification || "";
      const summary = analysisData.summary || "";
      const disconnectReason = analysisData.call_disconnect_reason || "";

      if (lead) {
        const enrichUpdate = {};

        if (eventType === "platform_analysis_completed") {
          enrichUpdate.summary = summary;
          enrichUpdate.notes = `Ringg analysis: ${classification || "analyzed"}. ${disconnectReason ? `Disconnect: ${disconnectReason}` : ""}`.trim();

          const normalizedClassification = normalizeOutcomeLabel(classification);
          if (normalizedClassification && normalizedClassification !== lead.outcome) {
            const transcriptText = (lead.transcript || "").toLowerCase();
            if (hasDisinterestSignal(transcriptText)) {
              enrichUpdate.outcome = "not_interested";
              enrichUpdate.next_action = "none";
            } else {
              enrichUpdate.outcome = normalizedClassification;
              enrichUpdate.next_action = defaultNextActionForOutcome(normalizedClassification);
            }
          }
        }

        if (eventType === "client_analysis_completed" && Object.keys(analysisData).length > 0) {
          enrichUpdate.notes = `Ringg client analysis: ${JSON.stringify(analysisData).slice(0, 500)}`;
        }

        if (Object.keys(enrichUpdate).length > 0) {
          await updateRow(lead.id, enrichUpdate);
        }
      }

      // Also update calls table with analysis
      if (ringgCallId) {
        const { data: existingCall } = await supabase
          .from("calls")
          .select("raw_webhook")
          .eq("ringg_call_id", ringgCallId)
          .maybeSingle();

        if (existingCall) {
          const existingRaw = existingCall.raw_webhook || {};
          await supabase
            .from("calls")
            .update({
              raw_webhook: { ...existingRaw, [eventType]: payload },
            })
            .eq("ringg_call_id", ringgCallId);
        }
      }

      return res.status(200).json({ received: true });
    }

    // --- Terminal (call_completed): classify outcome ---
    let answeredBy = "unknown";
    if (status === "completed") answeredBy = "human";
    else if (status === "failed") answeredBy = "no_answer";

    const { outcome, next_action } = classifyOutcome({
      answeredBy,
      summary: "",
      transcript,
      completed: status === "completed",
      callLength: durationSec,
      dispositionTag: null,
    });

    let finalOutcome = outcome;
    let finalNextAction = next_action;
    let outcomeSource = "local_classifier";
    const lowerTranscript = transcript.toLowerCase();

    if (status === "failed" || status === "retry") {
      finalOutcome = "no_answer";
      finalNextAction = "call_back_later";
      outcomeSource = "status_mapping";
    } else if (status === "completed" && hasDisinterestSignal(lowerTranscript)) {
      finalOutcome = "not_interested";
      finalNextAction = "none";
      outcomeSource = "disinterest_signal";
    } else if (status === "completed" && hasStrongInterestSignal(lowerTranscript)) {
      finalOutcome = "interested";
      finalNextAction = "human_followup";
      outcomeSource = "interest_signal";
    }

    const callStatusMap = {
      "opt_out": "opt_out",
      "not_interested": "completed",
      "no_answer": "no_answer",
      "voicemail": "voicemail",
      "interested": "completed",
      "human_followup": "completed",
    };
    const callStatus = callStatusMap[finalOutcome] || "completed";

    console.log(`Ringg webhook: call_id=${ringgCallId}, event=${eventType}, status=${status}, final_outcome=${finalOutcome}, source=${outcomeSource}`);

    await upsertRinggCallTracking({
      ringgCallId,
      lead,
      leadId,
      propertyId,
      phoneE164,
      status,
      outcome: finalOutcome,
      nextAction: finalNextAction,
      durationSec,
      transcript,
      recordingUrl,
      outcomeSource,
      payload,
      isTerminal: true,
    });

    if (lead) {
      await updateRow(lead.id, {
        ringg_call_id: ringgCallId || lead.ringg_call_id || null,
        call_provider: "ringg",
        call_status: callStatus,
        outcome: finalOutcome,
        next_action: finalNextAction,
        recording_url: recordingUrl,
        transcript,
        notes: `Ringg call - ${status}`,
        last_call_at: new Date().toISOString(),
      });
    }

    if (finalOutcome === "interested" && lead) {
      sendWhatsAppHotLeadAlert({
        leadName: lead.lead_name || customArgs.lead_name || "",
        phoneE164: payload.to_number || lead.phone_e164 || "",
        propertyName: lead.property_name || customArgs.property_name || "Tulip Monsella",
        callSummary: `Ringg AI call - Lead showed interest. Duration: ${durationSec ?? 0}s`,
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Ringg webhook error:", err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// Serve static files AFTER all API routes
app.use(express.static(PUBLIC_DIR));

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
