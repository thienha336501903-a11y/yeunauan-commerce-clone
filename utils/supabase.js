import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const previewFixture = process.env.COMMERCE_DATA_MODE === "fixture";

if ((!supabaseUrl || !supabaseServiceKey) && !previewFixture) {
  console.warn("CẢNH BÁO: Thiếu biến môi trường SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.");
}

export const supabase = createClient(
  supabaseUrl || (previewFixture ? "http://127.0.0.1:54321" : ""),
  supabaseServiceKey || (previewFixture ? "preview-fixture-key" : ""),
  {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});
