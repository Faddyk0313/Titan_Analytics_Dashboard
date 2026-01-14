import { NextResponse } from "next/server";
import { google } from "googleapis";

const TZ = "America/New_York";

// Read Summary with header row so we can map columns safely
const SKU_DEFS_RANGE = "Summary!A1:Z";
const SNAPSHOT_SHEET = "inventory_snapshots";

// Hardcoded weights (matches Andries tables)
const PRODUCT_CLASS_WEIGHT: Record<string, number> = { A: 4, B: 3, C: 2, LE: 1 };
const SIZE_CLASS_WEIGHT: Record<string, number> = { A: 3, B: 1 };

// Core sizes => Size Class A, everything else => B
const SIZE_CLASS_A_SET = new Set(["YTH-MD", "YTH-LG", "YTH-XL", "SR-SM", "SR-MD", "SR-LG"]);

function getETDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getETTimestamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizeHeader(h: string) {
  return h
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function buildHeaderIndexMap(headerRow: any[]) {
  const map: Record<string, number> = {};
  for (let i = 0; i < headerRow.length; i++) {
    const key = normalizeHeader(headerRow[i] ?? "");
    if (key) map[key] = i;
  }
  return map;
}

function getByHeader(
  row: any[],
  headerMap: Record<string, number>,
  keys: string[],
  fallbackIndex?: number
) {
  for (const k of keys) {
    const idx = headerMap[k];
    if (typeof idx === "number") return row?.[idx];
  }
  if (typeof fallbackIndex === "number") return row?.[fallbackIndex];
  return undefined;
}

function deriveSizeClassFromSize(sizeRaw: string): "A" | "B" {
  const size = (sizeRaw || "").toString().trim().toUpperCase();
  return SIZE_CLASS_A_SET.has(size) ? "A" : "B";
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function shopifyGraphQL(params: {
  shopDomain: string;
  adminToken: string;
  apiVersion: string;
  query: string;
  variables?: any;
}) {
  const { shopDomain, adminToken, apiVersion, query, variables } = params;

  const res = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": adminToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify GraphQL error ${res.status}: ${text}`);
  }

  return (await res.json()) as any;
}

async function fetchAllVariants(params: {
  shopDomain: string;
  adminToken: string;
  apiVersion: string;
}) {
  const { shopDomain, adminToken, apiVersion } = params;

  // Pull all variants (about 1,000) with SKU, product name, variant id, inventory item id
  const query = `
    query Variants($first: Int!, $after: String) {
      productVariants(first: $first, after: $after, query: "product_status:active") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            sku
            title
            product { title }
            inventoryItem { id }
          }
        }
      }
    }
  `;

  const all: Array<{
    sku: string;
    productName: string;
    variantId: string;
    inventoryItemId: string;
  }> = [];

  let after: string | null = null;
  const first = 250;

  while (true) {
    const json = await shopifyGraphQL({
      shopDomain,
      adminToken,
      apiVersion,
      query,
      variables: { first, after },
    });

    const conn = json?.data?.productVariants;
    const edges = conn?.edges || [];

    for (const e of edges) {
      const n = e?.node;
      const sku = (n?.sku || "").toString().trim();
      if (!sku) continue; // skip variants without SKU, since our join key is SKU

      const variantGid = n?.id as string;
      const invItemGid = n?.inventoryItem?.id as string;

      const variantId = variantGid?.split("/").pop() || "";
      const inventoryItemId = invItemGid?.split("/").pop() || "";

      const productTitle = (n?.product?.title || "").toString().trim();
      const variantTitle = (n?.title || "").toString().trim();

      // Store product_name as "Product Title - Variant Title" to be useful in Looker
      const productName =
        variantTitle && variantTitle !== "Default Title"
          ? `${productTitle} - ${variantTitle}`
          : productTitle;

      if (!variantId || !inventoryItemId) continue;

      all.push({ sku, productName, variantId, inventoryItemId });
    }

    const pageInfo = conn?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo?.endCursor || null;
  }

  return all;
}

async function fetchInventoryLevelsBatch(params: {
  shopDomain: string;
  adminToken: string;
  apiVersion: string;
  locationId: string;
  inventoryItemIds: string[];
}) {
  const { shopDomain, adminToken, apiVersion, locationId, inventoryItemIds } = params;

  const out = new Map<string, number>();

  // Shopify REST supports multiple inventory_item_ids in a single request.
  // Chunk to avoid URL length and be gentle on rate limits.
  const batches = chunk(inventoryItemIds, 50);

  for (const batchIds of batches) {
    const url = `https://${shopDomain}/admin/api/${apiVersion}/inventory_levels.json?inventory_item_ids=${encodeURIComponent(
      batchIds.join(",")
    )}&location_ids=${encodeURIComponent(locationId)}`;

    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": adminToken,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      // If a batch fails, set them to 0 rather than killing the whole run
      for (const id of batchIds) out.set(id, 0);
      continue;
    }

    const json = (await res.json()) as any;
    const levels = json?.inventory_levels || [];

    for (const lvl of levels) {
      const invItemId = String(lvl?.inventory_item_id || "");
      const locId = String(lvl?.location_id || "");
      const avail = lvl?.available;

      if (locId === String(locationId) && invItemId) {
        out.set(invItemId, typeof avail === "number" ? avail : 0);
      }
    }

    // Any inventory item not returned by the endpoint is effectively 0 at that location
    for (const id of batchIds) {
      if (!out.has(id)) out.set(id, 0);
    }
  }

  return out;
}

export async function POST(req: Request) {
  try {
    // Security check
    const secret = req.headers.get("x-cron-secret");
    if (!secret || secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Required env vars
    const GOOGLE_SHEET_ID = requireEnv("GOOGLE_SHEET_ID");
    const GOOGLE_CLIENT_EMAIL = requireEnv("GOOGLE_CLIENT_EMAIL");
    const GOOGLE_PRIVATE_KEY = requireEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");

    const SHOPIFY_STORE_DOMAIN = requireEnv("SHOPIFY_STORE_DOMAIN");
    const SHOPIFY_ADMIN_TOKEN = requireEnv("SHOPIFY_ADMIN_TOKEN");
    const SHOPIFY_API_VERSION = requireEnv("SHOPIFY_API_VERSION");
    const SHOPIFY_LOCATION_ID = requireEnv("SHOPIFY_LOCATION_ID");

    const snapshotDate = getETDate();
    const snapshotTs = getETTimestamp();
    const runId = `${snapshotDate}-${Date.now()}`;

    // Google Sheets auth
    const auth = new google.auth.JWT({
      email: GOOGLE_CLIENT_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.file",
      ],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // Skip if today's snapshot already exists
    const existingDates = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SNAPSHOT_SHEET}!A:A`,
    });
    const dateCol = existingDates.data.values?.flat() || [];
    if (dateCol.includes(snapshotDate)) {
      return NextResponse.json({
        status: "skipped",
        reason: "Snapshot already exists for today",
        snapshotDate,
      });
    }

    // Read Summary (tracked SKUs) and build a map keyed by SKU
    const skuSheet = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: SKU_DEFS_RANGE,
    });

    const all = skuSheet.data.values || [];
    if (all.length < 2) {
      return NextResponse.json(
        { status: "error", message: "Summary sheet has no rows to process" },
        { status: 500 }
      );
    }

    const headerRow = all[0];
    const headerMap = buildHeaderIndexMap(headerRow);
    const rows = all.slice(1);

    // Fallback indexes (your sheet was weird earlier, keep these as safety)
    const FALLBACK = {
      colorway: 2, // C
      size: 3, // D
      class: 12, // M
      safety: 14, // O
      sku: 17, // R
    };

    const trackedBySku = new Map<
      string,
      { colorway: string; size: string; classValue: string; safetyStock: number }
    >();

    for (const r of rows) {
      const sku = (getByHeader(r, headerMap, ["sku"], FALLBACK.sku) || "")
        .toString()
        .trim();
      if (!sku) continue;

      const colorway = (getByHeader(r, headerMap, ["colorway"], FALLBACK.colorway) || "")
        .toString()
        .trim();

      const size = (getByHeader(r, headerMap, ["size"], FALLBACK.size) || "")
        .toString()
        .trim();

      const classValue = (
        getByHeader(r, headerMap, ["class"], FALLBACK.class) || ""
      )
        .toString()
        .trim()
        .toUpperCase();

      const safetyStockRaw = getByHeader(
        r,
        headerMap,
        ["safety_stock", "safety"],
        FALLBACK.safety
      );
      const safetyStock = Number(safetyStockRaw || 0) || 0;

      trackedBySku.set(sku, { colorway, size, classValue, safetyStock });
    }

    // Pull full catalog variants from Shopify
    const variants = await fetchAllVariants({
      shopDomain: SHOPIFY_STORE_DOMAIN,
      adminToken: SHOPIFY_ADMIN_TOKEN,
      apiVersion: SHOPIFY_API_VERSION,
    });

    // Batch fetch inventory for all inventory item IDs for the location
    const inventoryItemIds = variants.map((v) => v.inventoryItemId);
    const invMap = await fetchInventoryLevelsBatch({
      shopDomain: SHOPIFY_STORE_DOMAIN,
      adminToken: SHOPIFY_ADMIN_TOKEN,
      apiVersion: SHOPIFY_API_VERSION,
      locationId: SHOPIFY_LOCATION_ID,
      inventoryItemIds,
    });

    // Build snapshot rows for ALL variants
    const snapshotRows: any[] = [];
    const errors: Array<{ sku: string; stage: string; detail: string }> = [];

    for (const v of variants) {
      const tracked = trackedBySku.get(v.sku);

      const classValue = tracked?.classValue || "";
      const safetyStock = tracked?.safetyStock ?? 0;

      // Only populate these if tracked, otherwise blank
      const colorway = tracked ? tracked.colorway : "";
      const size = tracked ? tracked.size : "";
      const sizeClass = tracked ? deriveSizeClassFromSize(size) : "";

      // Weights only apply to tracked SKUs
      const productClassWeight = tracked ? PRODUCT_CLASS_WEIGHT[classValue] ?? 0 : 0;
      const sizeClassWeight = tracked ? SIZE_CLASS_WEIGHT[sizeClass as "A" | "B"] ?? 0 : 0;
      const totalWeight = tracked ? productClassWeight * sizeClassWeight : 0;

      const availableQty = invMap.get(v.inventoryItemId) ?? 0;

      // Heatmap metric (recommended)
      const balanceVsSafety = tracked ? availableQty - safetyStock : 0;

      // Binary scoring uses safety stock when defined (your current scoring approach)
      const inStockBinary = tracked
        ? safetyStock > 0
          ? availableQty >= safetyStock
          : availableQty > 0
        : false;

      const inStockFlag = inStockBinary ? 1 : 0;
      const weightedInStock = inStockFlag * totalWeight;

      // v2 scoring: in stock if available_qty > 0 (tracked only)
      const inStockAnyFlag = tracked && availableQty > 0 ? 1 : 0;
      const weightedInStockAny = inStockAnyFlag * totalWeight;

      snapshotRows.push([
        snapshotDate, // A snapshot_date_et
        snapshotTs, // B snapshot_ts_et
        runId, // C run_id
        v.sku, // D sku
        v.productName, // E product_name
        colorway, // F colorway (blank if untracked)
        size, // G size (blank if untracked)
        classValue, // H class (blank if untracked)
        sizeClass, // I size_class (blank if untracked)
        safetyStock, // J safety_stock (0 if untracked)
        v.variantId, // K shopify_variant_id
        v.inventoryItemId, // L inventory_item_id
        SHOPIFY_LOCATION_ID, // M location_id
        availableQty, // N available_qty
        balanceVsSafety, // O balance_vs_safety (0 if untracked)
        productClassWeight, // P product_class_weight
        sizeClassWeight, // Q size_class_weight
        totalWeight, // R total_weight
        inStockFlag, // S in_stock_flag (v1)
        weightedInStock, // T weighted_in_stock (v1)
        tracked ? 1 : 0, // U is_tracked
        inStockAnyFlag, // V in_stock_any_flag (v2)
        weightedInStockAny, // W weighted_in_stock_any (v2)
      ]);
    }

    // Append rows
    if (snapshotRows.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${SNAPSHOT_SHEET}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: snapshotRows },
      });
    }

    return NextResponse.json({
      status: "ok",
      snapshotDate,
      rowsInserted: snapshotRows.length,
      trackedCount: variants.filter((v) => trackedBySku.has(v.sku)).length,
      errorsCount: errors.length,
      errors: errors.slice(0, 25),
    });
  } catch (err: any) {
    return NextResponse.json(
      { status: "error", message: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
