import { commerceRuntimeConfig } from '../utils/public-urls.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try { return res.status(200).json(commerceRuntimeConfig()); }
  catch (error) { return res.status(503).json({ error: error.message, code: 'clone_config_invalid' }); }
}
