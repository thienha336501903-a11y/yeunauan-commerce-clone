export const SALES_SITES = Object.freeze({
  yeunauan: Object.freeze({
    code: "yeunauan",
    label: "yeubep.shop",
    baseUrl: "https://yeubep.shop",
    host: "yeubep.shop"
  }),
  yeubep: Object.freeze({
    code: "yeubep",
    label: "shop.yeunauan.live",
    baseUrl: "https://shop.yeunauan.live",
    host: "shop.yeunauan.live"
  })
});

export function normalizeSalesSite(value, fallback = "yeunauan") {
  const code = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SALES_SITES, code)) return code;
  if (fallback === null) return null;
  return Object.prototype.hasOwnProperty.call(SALES_SITES, fallback) ? fallback : "yeunauan";
}

export function requireSalesSite(value) {
  const code = normalizeSalesSite(value, null);
  if (!code) {
    const error = new Error("WEBSITE BÁN HÀNG không hợp lệ");
    error.statusCode = 400;
    throw error;
  }
  return code;
}

export function getSalesSiteConfig(value) {
  return SALES_SITES[requireSalesSite(value)];
}

export function getDeploymentSalesSite() {
  return requireSalesSite(process.env.SALES_SITE);
}

export function getPublicSiteUrl(site = getDeploymentSalesSite()) {
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  const configured = String(process.env.PUBLIC_SITE_URL || "").trim().replace(/\/$/, "");
  return configured || getSalesSiteConfig(site).baseUrl;
}

export function buildCourseSalesUrl(course) {
  const site = normalizeSalesSite(course?.sales_site);
  return `${getSalesSiteConfig(site).baseUrl}/?course=${encodeURIComponent(course?.slug || "")}`;
}

export function applyCourseTenantFilter(query, salesSite) {
  const site = requireSalesSite(salesSite);
  return site === "yeunauan"
    ? query.or("sales_site.eq.yeunauan,sales_site.is.null")
    : query.eq("sales_site", "yeubep");
}

export const applyOrderTenantFilter = applyCourseTenantFilter;

export function effectiveSalesSite(row) {
  return normalizeSalesSite(row?.sales_site);
}
