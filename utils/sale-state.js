export function isSalePaused(course) {
  return course?.raw_data?.salePaused === true;
}

// Owner switch for selling through Messenger (H5): PUBLIC_CHECKOUT_DISABLED=1 closes the public bill-upload
// checkout on every course without touching course rows; unset it to reopen. Admin, /api/orders and Agency are unaffected.
export function isPublicCheckoutDisabled(env = process.env) {
  return /^(1|true)$/i.test(String(env?.PUBLIC_CHECKOUT_DISABLED || '').trim());
}

// A Telegram course without a connected group/channel cannot deliver: never on sale (G1, Owner 25/11).
export function telegramNotConnected(course) {
  return String(course?.delivery_mode || '').toLowerCase() === 'telegram' && !String(course?.telegram_chat_id || '').trim();
}

export function isCourseForSale(course) {
  return course?.active === true && !isSalePaused(course);
}
