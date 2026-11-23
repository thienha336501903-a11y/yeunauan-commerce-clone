// Env for test/telegram-delivery.test.js; imported first so the Supabase client and Telegram config see it.
process.env.SUPABASE_URL = 'http://localhost:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-bot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'tg-secret';
process.env.TELEGRAM_ADMIN_CHAT_ID = '-100900';
process.env.TELEGRAM_ADMIN_USER_IDS = '777';
