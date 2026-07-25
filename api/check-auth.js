import { warmRuntimeConfig } from "../utils/v2-runtime-controller.js";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Warm the V1/V2 runtime master-switch cache once per request so the
  // synchronous restrict-only gate (isV2ActiveCached) is populated for the
  // rest of the invocation. Never throws; cold-cache fail-open preserves V1.
  await warmRuntimeConfig();

  if (req.method === 'POST') {
    const { password } = req.body || {};
    const systemPassword = process.env.ADMIN_PASSWORD;

    if (!systemPassword) {
      return res.status(500).json({ authenticated: false });
    }

    if (password === systemPassword) {
      return res.status(200).json({ authenticated: true });
    }

    return res.status(401).json({ authenticated: false });
  }

  return res.status(405).json({ authenticated: false });
}
