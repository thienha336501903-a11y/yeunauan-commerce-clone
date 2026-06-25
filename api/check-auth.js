export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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
