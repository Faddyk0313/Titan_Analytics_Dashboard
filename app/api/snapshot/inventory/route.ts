import { NextResponse } from "next/server";
import { google } from "googleapis";

const TZ = "America/New_York";

// Include header row so we can map columns safely
const SKU_DEFS_RANGE = "Summary!A1:Z";
const SNAPSHOT_SHEET = "inventory_snapshots";

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

// Andries product class weights
const PRODUCT_CLASS_WEIGHT: Record<string, number> = {
  A: 4,
  B: 3,
  C: 2,
  LE: 1,
};

// Andries size class weights
const SIZE_CLASS_WEIGHT: Record<string, number> = {
  A: 3,
  B: 1,
};

// Derive Size Class from Size because Summary does not have a Size Class column
const SIZE_CLASS_A_SET = new Set([
  "YTH-MD",
  "YTH-LG",
  "YTH-XL",
  "SR-SM",
  "SR-MD",
  "SR-LG",
]);

function deriveSizeClassFromSize(sizeRaw: string): "A" | "B" {
  const size = (sizeRaw || "").toString().trim().toUpperCase();
  return SIZE_CLASS_A_SET.has(size) ? "A" : "B";
}

// More reliable than /variants.json?sku=... : use Admin GraphQL search query by SKU
async function fetchVariantBySkuGraphQL(params: {
  shopDomain: string;
  adminToken: string;
  apiVersion: string;
  sku: string;
}): Promise<{ variantId: string; inventoryItemId: string } | null> {
  const { shopDomain, adminToken, apiVersion, sku } = params;

  const query = `
    query VariantBySku($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            id
            inventoryItem {
              id
            }
          }
        }
      }
    }
  `;

  const variables = { query: `sku:"${sku}"` };

  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": adminToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify GraphQL error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as any;
  const edge = json?.data?.productVariants?.edges?.[0];
  const node = edge?.node;

  const variantGid = node?.id as string | undefined;
  const invItemGid = node?.inventoryItem?.id as string | undefined;

  if (!variantGid || !invItemGid) return null;

  const variantId = variantGid.split("/").pop()!;
  const inventoryItemId = invItemGid.split("/").pop()!;

  return { variantId, inventoryItemId };
}

async function fetchAvailableInventoryREST(params: {
  shopDomain: string;
  adminToken: string;
  apiVersion: string;
  inventoryItemId: string;
  locationId: string;
}): Promise<number> {
  const { shopDomain, adminToken, apiVersion, inventoryItemId, locationId } =
    params;

  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/inventory_levels.json?inventory_item_ids=${encodeURIComponent(
      inventoryItemId
    )}&location_ids=${encodeURIComponent(locationId)}`,
    {
      headers: {
        "X-Shopify-Access-Token": adminToken,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) return 0;

  const json = (await res.json()) as any;

  const level = (json?.inventory_levels || []).find(
    (l: any) => String(l.location_id) === String(locationId)
  );

  return typeof level?.available === "number" ? level.available : 0;
}

export async function POST(req: Request) {
  try {
    // --- Security check ---
    const secret = req.headers.get("x-cron-secret");
    if (!secret || secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // --- Required env vars ---
    const GOOGLE_SHEET_ID = requireEnv("GOOGLE_SHEET_ID");
    const GOOGLE_CLIENT_EMAIL = requireEnv("GOOGLE_CLIENT_EMAIL");
    const GOOGLE_PRIVATE_KEY = requireEnv("GOOGLE_PRIVATE_KEY").replace(
      /\\n/g,
      "\n"
    );

    const SHOPIFY_STORE_DOMAIN = requireEnv("SHOPIFY_STORE_DOMAIN");
    const SHOPIFY_ADMIN_TOKEN = requireEnv("SHOPIFY_ADMIN_TOKEN");
    const SHOPIFY_API_VERSION = requireEnv("SHOPIFY_API_VERSION");
    const SHOPIFY_LOCATION_ID = requireEnv("SHOPIFY_LOCATION_ID");

    const snapshotDate = getETDate();
    const snapshotTs = getETTimestamp();
    const runId = `${snapshotDate}-${Date.now()}`;

    // --- Google Sheets auth ---
    const auth = new google.auth.JWT({
      email: GOOGLE_CLIENT_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.file",
      ],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // --- Skip if today's snapshot already exists ---
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

    // --- Read SKU definitions (with headers) ---
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

    // Fallback indexes if headers change unexpectedly
    const FALLBACK = {
      colorway: 3,
      size: 4,
      class: 12,
      safety: 14,
      sku: 17,
    };

    const snapshotRows: any[] = [];
    const errors: Array<{ sku: string; stage: string; detail: string }> = [];

    for (const r of rows) {
      const sku = (getByHeader(r, headerMap, ["sku"], FALLBACK.sku) || "")
        .toString()
        .trim();
      if (!sku) continue;

      const colorway = (
        getByHeader(r, headerMap, ["colorway"], FALLBACK.colorway) || ""
      )
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

      const sizeClass = deriveSizeClassFromSize(size);

      const productClassWeight = PRODUCT_CLASS_WEIGHT[classValue] ?? 0;
      const sizeClassWeight = SIZE_CLASS_WEIGHT[sizeClass] ?? 0;
      const totalWeight = productClassWeight * sizeClassWeight;

      // --- Find variant + inventory item by SKU ---
      const variantInfo = await fetchVariantBySkuGraphQL({
        shopDomain: SHOPIFY_STORE_DOMAIN,
        adminToken: SHOPIFY_ADMIN_TOKEN,
        apiVersion: SHOPIFY_API_VERSION,
        sku,
      });

      if (!variantInfo) {
        errors.push({
          sku,
          stage: "variant_lookup",
          detail: `Variant not found by SKU via GraphQL (query sku:"${sku}")`,
        });
        continue;
      }

      const { variantId, inventoryItemId } = variantInfo;

      // --- Fetch inventory available at the chosen location ---
      const availableQty = await fetchAvailableInventoryREST({
        shopDomain: SHOPIFY_STORE_DOMAIN,
        adminToken: SHOPIFY_ADMIN_TOKEN,
        apiVersion: SHOPIFY_API_VERSION,
        inventoryItemId,
        locationId: SHOPIFY_LOCATION_ID,
      });

      // --- Heatmap metric support ---
      // This is the best heatmap signal because it includes safety stock context
      const balanceVsSafety = availableQty - safetyStock;

      // --- Andries binary scoring (stock position) ---
      // If safety stock exists: "in stock" only if we meet or exceed safety
      // If no safety stock: "in stock" only if available > 0
      const inStockBinary =
        safetyStock > 0 ? availableQty >= safetyStock : availableQty > 0;

      const inStockFlag = inStockBinary ? 1 : 0;

      // Numerator contribution per SKU (X)
      const weightedInStock = inStockFlag * totalWeight;

      snapshotRows.push([
        snapshotDate, // A snapshot_date_et
        snapshotTs, // B snapshot_ts_et
        runId, // C run_id
        sku, // D sku
        colorway, // E colorway
        size, // F size
        classValue, // G class
        sizeClass, // H size_class
        safetyStock, // I safety_stock
        variantId, // J shopify_variant_id
        inventoryItemId, // K inventory_item_id
        SHOPIFY_LOCATION_ID, // L location_id
        availableQty, // M available_qty (for your old inventory-sum heatmap)
        balanceVsSafety, // N balance_vs_safety (recommended heatmap metric)
        productClassWeight, // O product_class_weight
        sizeClassWeight, // P size_class_weight
        totalWeight, // Q total_weight (denominator piece)
        inStockFlag, // R in_stock_flag
        weightedInStock, // S weighted_in_stock (numerator piece)
      ]);
    }

    // --- Append rows ---
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

// Optional: explicitly block GET
export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
