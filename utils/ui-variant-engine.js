/**
 * utils/ui-variant-engine.js
 *
 * Multi-Surface UI Variant Engine & Layout Architecture.
 * Milestone B7: Multi-surface UI variant contracts across:
 * - storefront
 * - checkout
 * - agency admin
 * - learner
 * - learning/player
 * - homework
 *
 * Implements default variant (Agency A compatible) + alternate test variants
 * to prove radical structural differentiation without forking the application business core.
 */

export const UI_SURFACES = {
  STOREFRONT: "storefront",
  CHECKOUT: "checkout",
  ADMIN: "admin",
  LEARNER: "learner",
  LEARNING: "learning",
  HOMEWORK: "homework"
};

export const UI_VARIANTS = {
  [UI_SURFACES.STOREFRONT]: {
    DEFAULT: "classic_culinary",
    ALTERNATES: ["modern_grid", "editorial_showcase"]
  },
  [UI_SURFACES.CHECKOUT]: {
    DEFAULT: "one_page_qr",
    ALTERNATES: ["multi_step_express"]
  },
  [UI_SURFACES.ADMIN]: {
    DEFAULT: "standard_agency",
    ALTERNATES: ["compact_pro"]
  },
  [UI_SURFACES.LEARNER]: {
    DEFAULT: "card_dashboard",
    ALTERNATES: ["linear_curriculum"]
  },
  [UI_SURFACES.LEARNING]: {
    DEFAULT: "cinema_player",
    ALTERNATES: ["sidebar_notes_player"]
  },
  [UI_SURFACES.HOMEWORK]: {
    DEFAULT: "photo_submission",
    ALTERNATES: ["graded_rubric"]
  }
};

export const DEFAULT_DESIGN_TOKENS = Object.freeze({
  primaryColor: "#e11d48",
  secondaryColor: "#4b5563",
  fontFamily: "Inter, sans-serif",
  borderRadius: "8px"
});

/**
 * Returns supported variants for a specific UI surface.
 */
export function getSupportedVariants(surface) {
  const surfaceConfig = UI_VARIANTS[surface];
  if (!surfaceConfig) return [];
  return [surfaceConfig.DEFAULT, ...surfaceConfig.ALTERNATES];
}

/**
 * Resolves the variant and design tokens for a given surface from an agency UI profile.
 * Falls back safely to default variant if profile or variant is missing/invalid.
 */
export function resolveSurfaceVariant(uiProfile = {}, surface) {
  const surfaceConfig = UI_VARIANTS[surface];
  if (!surfaceConfig) {
    throw new Error(`Unsupported UI surface: ${surface}`);
  }

  const profileKey = `${surface}_variant`;
  const rawVariant = uiProfile[profileKey] || surfaceConfig.DEFAULT;
  const supported = getSupportedVariants(surface);
  const activeVariant = supported.includes(rawVariant) ? rawVariant : surfaceConfig.DEFAULT;

  return {
    surface,
    variant: activeVariant,
    isDefault: activeVariant === surfaceConfig.DEFAULT,
    brandName: uiProfile.brand_name || "Academy",
    logoUrl: uiProfile.logo_url || null,
    faviconUrl: uiProfile.favicon_url || null,
    designTokens: {
      ...DEFAULT_DESIGN_TOKENS,
      ...(uiProfile.design_tokens || {})
    },
    featureFlags: {
      enableReviews: true,
      enableDeviceLock: true,
      enableCommunity: false,
      ...(uiProfile.feature_flags || {})
    }
  };
}

/**
 * Dynamic layout / component dispatcher.
 * Proves B7_NO_BUSINESS_CORE_FORK:
 * Takes canonical business payload (courses, orders, player stream, homework)
 * and transforms it into the structural UI view contract for the resolved variant
 * WITHOUT altering any underlying business values, prices, IDs, or tokens.
 */
export function renderVariantLayout(surface, variant, payload = {}, options = {}) {
  const supported = getSupportedVariants(surface);
  if (!supported.includes(variant)) {
    throw new Error(`Invalid variant '${variant}' for surface '${surface}'`);
  }

  const tokens = options.designTokens || DEFAULT_DESIGN_TOKENS;

  switch (surface) {
    case UI_SURFACES.STOREFRONT:
      if (variant === "classic_culinary") {
        return {
          surface,
          layout: "classic_culinary",
          structure: "vertical_story",
          hero: {
            title: payload.hero?.title || "Khóa Học Nấu Ăn Chuyên Nghiệp",
            subtitle: payload.hero?.subtitle || "Học cùng các bếp trưởng hàng đầu",
            theme: "warm_amber"
          },
          sections: [
            {
              type: "featured_course_list",
              items: payload.courses || [],
              displayMode: "row_cards"
            }
          ],
          designTokens: tokens
        };
      } else if (variant === "modern_grid") {
        return {
          surface,
          layout: "modern_grid",
          structure: "css_grid_responsive",
          gridColumns: 3,
          hero: {
            title: payload.hero?.title || "Học Viện Kỹ Năng Trực Tuyến",
            badge: "Trending 2026",
            theme: "cool_indigo"
          },
          sections: [
            {
              type: "catalog_grid",
              items: payload.courses || [],
              displayMode: "compact_grid",
              badgeOverlay: true
            }
          ],
          designTokens: tokens
        };
      } else {
        return {
          surface,
          layout: "editorial_showcase",
          structure: "magazine_layout",
          featuredLead: payload.courses?.[0] || null,
          sections: [{ type: "archive_list", items: (payload.courses || []).slice(1) }],
          designTokens: tokens
        };
      }

    case UI_SURFACES.CHECKOUT:
      if (variant === "one_page_qr") {
        return {
          surface,
          layout: "one_page_qr",
          flow: "single_screen",
          order: payload.order,
          bankSnapshot: payload.bankSnapshot,
          vietQrModal: {
            mode: "inline_qr",
            autoPollPayment: true
          },
          designTokens: tokens
        };
      } else {
        return {
          surface,
          layout: "multi_step_express",
          flow: "stepped_wizard",
          steps: [
            { id: 1, name: "phone_entry", completed: !!payload.order?.phone },
            { id: 2, name: "payment_qr", active: true }
          ],
          order: payload.order,
          bankSnapshot: payload.bankSnapshot,
          vietQrModal: {
            mode: "drawer_modal",
            autoPollPayment: true
          },
          designTokens: tokens
        };
      }

    case UI_SURFACES.ADMIN:
      if (variant === "standard_agency") {
        return {
          surface,
          layout: "standard_agency",
          density: "comfortable",
          quickEnrollModal: true,
          tableColumns: ["id", "customer_name", "phone", "price_vnd", "status", "created_at"],
          statsCards: payload.stats || {},
          designTokens: tokens
        };
      } else {
        return {
          surface,
          layout: "compact_pro",
          density: "compact",
          quickEnrollModal: false,
          enableHotkeys: true,
          tableColumns: ["id", "phone", "price_vnd", "status"],
          statsCards: payload.stats || {},
          designTokens: tokens
        };
      }

    case UI_SURFACES.LEARNER:
      if (variant === "card_dashboard") {
        return {
          surface,
          layout: "card_dashboard",
          navigation: "top_tabs",
          progressVisualization: "circle_percentage",
          courses: payload.courses || [],
          designTokens: tokens
        };
      } else {
        return {
          surface,
          layout: "linear_curriculum",
          navigation: "timeline_vertical",
          progressVisualization: "milestone_stepper",
          courses: payload.courses || [],
          designTokens: tokens
        };
      }

    case UI_SURFACES.LEARNING:
      if (variant === "cinema_player") {
        return {
          surface,
          layout: "cinema_player",
          aspectRatio: "21:9",
          sidebarPosition: "drawer_collapsed",
          theaterMode: true,
          playbackData: payload.playbackData,
          designTokens: tokens
        };
      } else {
        return {
          surface,
          layout: "sidebar_notes_player",
          aspectRatio: "16:9",
          sidebarPosition: "docked_right",
          tabs: ["lesson_index", "chef_notes", "recipe_checklist"],
          playbackData: payload.playbackData,
          designTokens: tokens
        };
      }

    case UI_SURFACES.HOMEWORK:
      if (variant === "photo_submission") {
        return {
          surface,
          layout: "photo_submission",
          submissionType: "image_gallery",
          allowNotes: true,
          rubricEnabled: false,
          submissions: payload.submissions || [],
          designTokens: tokens
        };
      } else {
        return {
          surface,
          layout: "graded_rubric",
          submissionType: "multi_criteria_evaluation",
          allowNotes: true,
          rubricEnabled: true,
          rubricCriteria: [
            { key: "technique", label: "Kỹ thuật nấu nướng", maxScore: 5 },
            { key: "plating", label: "Trình bày thẩm mỹ", maxScore: 3 },
            { key: "flavor_balance", label: "Cân bằng hương vị", maxScore: 2 }
          ],
          submissions: payload.submissions || [],
          designTokens: tokens
        };
      }

    default:
      throw new Error(`Unhandled surface layout: ${surface}`);
  }
}
