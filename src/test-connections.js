import 'dotenv/config';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

const log = pino({ transport: { target: 'pino-pretty' } });

// -------------------- Test Supabase --------------------
async function testSupabase() {
  log.info('Testing Supabase connection...');
  
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  }
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Test 1: Insert a dummy call record
  log.info('Inserting test call record...');
  const testCall = {
    lead_id: 'test-lead-123',
    property_id: 'test-property-456',
    phone_e164: '+1234567890',
    bland_call_id: 'test-call-' + Date.now(),
    status: 'test',
    outcome: 'test_outcome',
    next_action: 'test_action',
    attempt: 1,
    started_at: new Date().toISOString(),
    transcript: 'This is a test transcript',
    raw_webhook: { test: true, timestamp: new Date().toISOString() },
  };
  
  const { data: insertData, error: insertError } = await supabase
    .from('calls')
    .insert(testCall)
    .select();
  
  if (insertError) {
    throw new Error(`Supabase insert failed: ${insertError.message}`);
  }
  
  log.info({ callId: insertData[0].id }, '✅ Supabase insert successful');
  
  // Test 2: Read it back
  log.info('Reading back the test record...');
  const { data: readData, error: readError } = await supabase
    .from('calls')
    .select('*')
    .eq('bland_call_id', testCall.bland_call_id)
    .single();
  
  if (readError) {
    throw new Error(`Supabase read failed: ${readError.message}`);
  }
  
  log.info({ record: readData }, '✅ Supabase read successful');
  
  // Test 3: Update it
  log.info('Updating the test record...');
  const { data: updateData, error: updateError } = await supabase
    .from('calls')
    .update({ outcome: 'updated_test_outcome' })
    .eq('bland_call_id', testCall.bland_call_id)
    .select();
  
  if (updateError) {
    throw new Error(`Supabase update failed: ${updateError.message}`);
  }
  
  log.info({ record: updateData[0] }, '✅ Supabase update successful');
  
  // Cleanup: Delete test record
  log.info('Cleaning up test record...');
  await supabase
    .from('calls')
    .delete()
    .eq('bland_call_id', testCall.bland_call_id);
  
  log.info('✅ Supabase cleanup successful');
  
  return true;
}

// -------------------- Test Google Sheets --------------------
async function testGoogleSheets() {
  log.info('Testing Google Sheets connection...');
  
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!b64) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 in .env');
  }
  
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  
  const auth = new google.auth.JWT({
    email: json.client_email,
    key: json.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  
  await auth.authorize();
  log.info('✅ Google Auth successful');
  
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tab = process.env.GOOGLE_SHEETS_TAB || 'Leads';
  
  if (!sheetId) {
    throw new Error('Missing GOOGLE_SHEETS_SPREADSHEET_ID in .env');
  }
  
  // First, list all available tabs
  log.info('Listing available tabs in spreadsheet...');
  const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const availableTabs = spreadsheetInfo.data.sheets.map(s => s.properties.title);
  log.info({ availableTabs }, 'Available tabs in spreadsheet');
  
  // Test 1: Read a small range to verify connection
  log.info(`Reading from sheet: ${sheetId}, tab: ${tab}...`);
  const range = `${tab}!A1:Z10`; // Just read first 10 rows
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });
  
  const values = res.data.values || [];
  log.info({ 
    rowCount: values.length,
    headers: values[0] || [],
    sampleRow: values[1] || null 
  }, '✅ Google Sheets read successful');
  
  // Test 2: Try to read all rows (as the server does)
  log.info('Reading all rows (as server does)...');
  const allRange = `${tab}!A1:Z10000`;
  const allRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: allRange,
  });
  
  const allValues = allRes.data.values || [];
  if (allValues.length < 2) {
    log.warn('Sheet has less than 2 rows (header + data). This is okay for testing.');
    return { headers: allValues[0] || [], rows: [] };
  }
  
  const headers = allValues[0];
  const rows = allValues.slice(1).map((row, idx) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] ?? ''));
    obj.__rowNumber = idx + 2;
    return obj;
  });
  
  log.info({ 
    totalRows: rows.length,
    sampleRow: rows[0] || null,
    headers 
  }, '✅ Google Sheets full read successful');
  
  return { headers, rows };
}

// -------------------- Main Test --------------------
async function runTests() {
  try {
    log.info('🚀 Starting connection tests...\n');
    
    // Test Supabase
    await testSupabase();
    log.info('\n');
    
    // Test Google Sheets
    await testGoogleSheets();
    log.info('\n');
    
    log.info('✅ All tests passed!');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, '❌ Test failed');
    process.exit(1);
  }
}

runTests();

