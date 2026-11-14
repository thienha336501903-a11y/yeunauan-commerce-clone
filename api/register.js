import { isPublicCheckoutDisabled } from '../utils/sale-state.js';
import { createBillOrder } from '../utils/bill-order.js';
import { resolveRequestRoute } from '../utils/agency-routing.js';
import { checkoutOffering } from '../utils/agency-commerce.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Agency checkout is Main-only. Legacy hosts continue through the unchanged
  // bill-upload/order path below.
  const options = req.__options || {};
  const routeDecision = await resolveRequestRoute(req, options);
  if (routeDecision.route === "DENY") {
    return res.status(routeDecision.status || 403).json({ error: routeDecision.error, code: routeDecision.code });
  }
  if (routeDecision.route === "AGENCY") {
    const result = await checkoutOffering(req, {
      offeringId: String(req.body?.offeringId || "").trim(),
      idempotencyOrderCode: String(req.body?.idempotencyOrderCode || "").trim() || undefined
    }, options);

    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        code: result.code || "agency_checkout_failed",
        error: result.error || "Agency checkout failed."
      });
    }

    return res.status(200).json({
      success: true,
      deliveryMode: "agency",
      order: result.order
    });
  }
  // Checked before the bill is read, so a closed checkout costs no parsing CPU.
  if (isPublicCheckoutDisabled()) {
    return res.status(409).json({ error: 'Khóa học đang tạm dừng nhận đăng ký.', code: 'sale_paused' });
  }
  const result = await createBillOrder(req.body);
  return res.status(result.status).json(result.body);
}
