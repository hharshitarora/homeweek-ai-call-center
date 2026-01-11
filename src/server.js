import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

// -------------------- setup --------------------
const log = pino({ transport: { target: 'pino-pretty' } });

const app = express();
// IMPORTANT: for webhook signature verification you may need raw body.
// For now we keep JSON; we can upgrade to raw later if Bland requires it.
app.use(express.json({ limit: '2mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---- Google Auth (service account) ----
function getGoogleAuth() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!b64) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON_BASE64');
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

  return new google.auth.JWT({
    email: json.client_email,
    key: json.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = getGoogleAuth();
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

const SHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const TAB = process.env.GOOGLE_SHEETS_TAB || 'Leads';

// -------------------- sheets helpers --------------------
async function readAllRows() {
  const sheets = await getSheetsClient();
  const range = `${TAB}!A1:Z10000`; // adjust if needed
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const values = res.data.values || [];
  if (values.length < 2) return { headers: values[0] || [], rows: [] };

  const headers = values[0];
  const rows = values.slice(1).map((row, idx) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] ?? ''));
    obj.__rowNumber = idx + 2; // sheet row number (1-based, header is row 1)
    return obj;
  });
  return { headers, rows };
}

async function updateRow(rowNumber, updates) {
  const sheets = await getSheetsClient();
  const { headers } = await readAllRows();
  const headerIndex = Object.fromEntries(headers.map((h, i) => [h, i]));

  // Read the whole row first (so we can write back updated row)
  const rowRange = `${TAB}!A${rowNumber}:Z${rowNumber}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: rowRange });
  const current = (res.data.values?.[0] ?? []);
  const newRow = [...current];

  for (const [key, value] of Object.entries(updates)) {
    const idx = headerIndex[key];
    if (idx === undefined) continue;
    newRow[idx] = value ?? '';
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: rowRange,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] },
  });
}

// -------------------- bland helpers --------------------
async function startBlandCall({ phone, prompt, metadata }) {
  const apiKey = process.env.BLAND_API_KEY;
  if (!apiKey) throw new Error('Missing BLAND_API_KEY');

  // NOTE: Replace this with Bland's exact endpoint + payload shape you're using.
  // This is intentionally written so you only edit ONE function later.
  const resp = await fetch('https://api.bland.ai/v1/calls', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phone_number: phone,
      task: prompt,
      webhook: process.env.PUBLIC_WEBHOOK_URL,
      metadata, // include lead_id/property_id/rowNumber, etc.
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Bland start call failed: ${resp.status} ${txt}`);
  }
  return await resp.json(); // should include call_id or similar
}

// -------------------- prompt builder --------------------
function buildPromptFromRow(row) {
  // Keep this identical to the prompt your dad approved, just inject facts
  return `
You are a professional, calm, and friendly real estate calling assistant for Homeseek Realtors, calling on behalf of Harshit Arora.

Goal: Confirm interest, qualify briefly, and propose a showing. Ask one question at a time. Never invent facts. If unsure, say Harshit will follow up.

Property facts:
- Address: ${row.property_address}
- Price: ${row.property_price_inr}
- Beds/Baths: ${row.property_beds_baths}
- Highlights: ${row.property_highlights}
- Showings: ${row.showing_windows}
- URL: ${row.property_url}

Flow:
1) "Hi, is this a bad time to talk?"
2) Identify + confirm they inquired about the property.
3) Interest check
4) Qualification: timeline, budget range, financing (optional)
5) If interested: ask if Harshit should coordinate a visit during showing windows.
6) If not interested or opt-out: apologize and end.

Hard rules:
- Do not negotiate or promise availability.
- If asked unknown info: collect the question and say Harshit will follow up.
`.trim();
}

// -------------------- routes --------------------
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/run-dialer', async (req, res) => {
  try {
    const { rows } = await readAllRows();

    const queued = rows
      .filter(r => (r.call_status || '').toLowerCase() === 'queued')
      .filter(r => Number(r.call_attempts || 0) < 3);

    // Rate limit Phase 1B: max 5 calls per run
    const batch = queued.slice(0, 5);

    for (const row of batch) {
      const rowNumber = row.__rowNumber;
      const attempts = Number(row.call_attempts || 0) + 1;

      await updateRow(rowNumber, {
        call_status: 'calling',
        call_attempts: String(attempts),
        last_call_at: new Date().toISOString(),
      });

      const prompt = buildPromptFromRow(row);
      const metadata = {
        lead_id: row.lead_id,
        property_id: row.property_id,
        sheet_row: rowNumber,
      };

      const startedAt = new Date().toISOString();
      let bland;
      try {
        bland = await startBlandCall({ phone: row.phone_e164, prompt, metadata });
      } catch (e) {
        log.error({ err: e, lead_id: row.lead_id }, 'Failed to start call');
        await updateRow(rowNumber, { call_status: 'failed', outcome: 'human_followup', next_action: 'human_followup' });
        continue;
      }

      const blandCallId = bland.call_id || bland.id || bland.callId || '';
      await updateRow(rowNumber, { bland_call_id: blandCallId });

      await supabase.from('calls').insert({
        lead_id: row.lead_id,
        property_id: row.property_id,
        phone_e164: row.phone_e164,
        bland_call_id: blandCallId || null,
        status: 'calling',
        attempt: attempts,
        started_at: startedAt,
        raw_webhook: { started_response: bland },
      });
    }

    res.json({ ok: true, processed: batch.length });
  } catch (e) {
    log.error({ err: e }, 'run-dialer failed');
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Webhook schema (we'll adapt to Bland's real payload once you paste one)
const BlandWebhookSchema = z.object({
  // Many providers send something like:
  call_id: z.string().optional(),
  id: z.string().optional(),
  metadata: z.any().optional(),
  transcript: z.string().optional(),
  recording_url: z.string().optional(),
  status: z.string().optional(),
  duration: z.number().optional(),
}).passthrough();

function mapOutcome({ status, transcript }) {
  const t = (transcript || '').toLowerCase();
  if (t.includes("don't call") || t.includes("do not call") || t.includes("stop calling")) {
    return { outcome: 'opt_out', next_action: 'none' };
  }
  if (status && ['no_answer', 'failed', 'busy'].includes(status.toLowerCase())) {
    return { outcome: 'no_answer', next_action: 'call_back_later' };
  }
  if (t.includes('interested') || t.includes('visit') || t.includes('showing') || t.includes('come by')) {
    return { outcome: 'interested', next_action: 'human_followup' }; // Phase 1B: dad closes
  }
  if (t.includes('call me back') || t.includes('later') || t.includes('tomorrow')) {
    return { outcome: 'callback', next_action: 'call_back_later' };
  }
  if (t.includes('not interested') || t.includes('no thanks')) {
    return { outcome: 'not_interested', next_action: 'none' };
  }
  return { outcome: 'human_followup', next_action: 'human_followup' };
}

app.post('/webhooks/bland', async (req, res) => {
  console.log("BLAND BODY:", JSON.stringify(req.body, null, 2));
  try {
    const parsed = BlandWebhookSchema.parse(req.body);

    const callId = parsed.call_id || parsed.id || '';
    const meta = parsed.metadata || {};
    const rowNumber = Number(meta.sheet_row || 0);
    const transcript = parsed.transcript || '';
    const recordingUrl = parsed.recording_url || '';
    const status = parsed.status || 'completed';
    const duration = parsed.duration || null;

    const { outcome, next_action } = mapOutcome({ status, transcript });

    // Update sheet if we know the row
    if (rowNumber) {
      await updateRow(rowNumber, {
        call_status: outcome === 'opt_out' ? 'opt_out' : 'completed',
        outcome,
        next_action,
        transcript,
        recording_url: recordingUrl,
      });
    }

    // Update Supabase
    if (callId) {
      await supabase.from('calls').update({
        status,
        outcome,
        next_action,
        duration_sec: duration,
        transcript,
        recording_url: recordingUrl,
        ended_at: new Date().toISOString(),
        raw_webhook: req.body,
      }).eq('bland_call_id', callId);
    } else {
      // If no call id, still store raw payload for debugging
      await supabase.from('calls').insert({
        status,
        outcome,
        next_action,
        transcript,
        recording_url: recordingUrl,
        raw_webhook: req.body,
      });
    }

    res.status(200).send("ok");
  } catch (e) {
    log.error({ err: e }, 'bland webhook failed');
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(process.env.PORT || 3000, () => {
  log.info(`Server running on :${process.env.PORT || 3000}`);
});

