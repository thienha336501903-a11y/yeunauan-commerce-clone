const BRAND_CONFIGS = {
  "www.yeubep.shop": {
    brandName: "Yêu Bếp",
    logo: "Yêu Bếp",
    favicon: "https://www.yeubep.shop/favicon.ico",
    primaryColor: "#b65c4b",
    primaryColorRgb: "182,92,75",
    adminTitle: "Admin - Quản lý Học viên (Yêu Bếp)",
    studentTitle: "Yêu Bếp — Đăng ký khóa học",
    metaTitle: "Yêu Bếp — Đăng ký khóa học online",
    metaDescription: "Đăng ký các khóa học nấu ăn online đặc sắc cùng Yêu Bếp. Nhập Gmail, chuyển khoản nhận quyền học tức thì.",
    footerText: "© 2026 Yêu Bếp. All rights reserved. Hỗ trợ học viên: support@yeubep.shop"
  },
  "shop.yeunauan.live": {
    brandName: "Yêu Nấu Ăn",
    logo: "Yêu Nấu Ăn",
    favicon: "https://yeunauan.live/favicon.ico",
    primaryColor: "#059669",
    primaryColorRgb: "5,150,105",
    adminTitle: "Admin - Quản lý Học viên (Yêu Nấu Ăn)",
    studentTitle: "Yêu Nấu Ăn — Đăng ký khóa học",
    metaTitle: "Yêu Nấu Ăn — Đăng ký khóa học online",
    metaDescription: "Đăng ký các khóa học nấu ăn trực tuyến cùng Yêu Nấu Ăn. Nhập Gmail, chuyển khoản nhận quyền học tức thì.",
    footerText: "© 2026 Yêu Nấu Ăn. All rights reserved. Hỗ trợ học viên: support@yeunauan.live"
  }
};

function getActiveBrand() {
  const hostname = window.location.hostname;
  if (BRAND_CONFIGS[hostname]) {
    return BRAND_CONFIGS[hostname];
  }
  // Mapping local development or vercel staging domains
  if (hostname.includes("yeunauan") || (typeof localStorage !== "undefined" && localStorage.getItem("dev_brand") === "yeunauan")) {
    return BRAND_CONFIGS["shop.yeunauan.live"];
  }
  // Default fallback
  return BRAND_CONFIGS["www.yeubep.shop"];
}

// 1. Immediately apply CSS variable colors to prevent UI flashing
(function applyColors() {
  const brand = getActiveBrand();
  if (brand) {
    if (brand.primaryColor) {
      document.documentElement.style.setProperty('--red', brand.primaryColor);
    }
    if (brand.primaryColorRgb) {
      document.documentElement.style.setProperty('--red-rgba', brand.primaryColorRgb);
    }
  }
})();

// 2. Apply metadata and text bindings on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  const brand = getActiveBrand();
  if (!brand) return;

  // Update Page Title
  document.title = brand.metaTitle || brand.studentTitle;

  // Update or create favicon link dynamically
  let faviconLink = document.querySelector("link[rel*='icon']");
  if (!faviconLink) {
    faviconLink = document.createElement('link');
    faviconLink.rel = 'shortcut icon';
    document.getElementsByTagName('head')[0].appendChild(faviconLink);
  }
  faviconLink.href = brand.favicon;

  // Update Meta tags
  let metaDesc = document.querySelector("meta[name='description']");
  if (!metaDesc) {
    metaDesc = document.createElement('meta');
    metaDesc.name = 'description';
    document.getElementsByTagName('head')[0].appendChild(metaDesc);
  }
  metaDesc.content = brand.metaDescription;

  // Update Text bindings
  document.querySelectorAll(".brand-name-bind").forEach(el => {
    el.innerText = brand.brandName;
  });

  document.querySelectorAll(".brand-logo-bind").forEach(el => {
    el.innerText = brand.logo;
  });

  document.querySelectorAll(".brand-footer-bind").forEach(el => {
    el.innerText = brand.footerText;
  });
});
