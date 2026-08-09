import crypto from "crypto";

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export default function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const password = req.body?.password;
  const systemPassword = process.env.ADMIN_PASSWORD;

  if (!systemPassword) {
    return res.status(500).json({
      success: false,
      message: "Hệ thống chưa cấu hình mật khẩu quản trị (ADMIN_PASSWORD)."
    });
  }

  if (safeEqual(password, systemPassword)) {
    return res.status(200).json({
      success: true,
      message: "Mật khẩu chính xác!"
    });
  }

  return res.status(401).json({
    success: false,
    message: "Sai mật khẩu bảo mật!"
  });
}
