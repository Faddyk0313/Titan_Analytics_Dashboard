import { NextResponse } from "next/server";
import { google } from "googleapis";

const TZ = "America/New_York";
const SKU_DEFS_RANGE = "Summary!A2:Z";
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

  const variables = { query: `sku:${sku}` };

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
  

  if (!res.ok) return null;

  const json = (await res.json()) as any;
  const edge = json?.data?.productVariants?.edges?.[0];
  const node = edge?.node;

  const variantGid = node?.id as string | undefined;
  const invItemGid = node?.inventoryItem?.id as string | undefined;

  if (!variantGid || !invItemGid) return null;

  // Convert gid://shopify/ProductVariant/123 -> 123
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

  // Safer than [0]
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

    const snapshotDate = getETDate(); // YYYY-MM-DD (ET)
    const snapshotTs = getETTimestamp(); // YYYY-MM-DD HH:mm:ss (ET)
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

    // --- Skip if today's snapshot already exists (prevent duplicates) ---
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

    // --- Read SKU definitions ---
    const skuSheet = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: SKU_DEFS_RANGE,
    });

    const rows = skuSheet.data.values || [];

    // Column indexes (0-based) for Summary!A2:Z
    // Confirmed by you:
    // Colorway C, Size D, Class M, Safety Stock O, SKU R
    const COL = {
      colorway: 2, // C
      size: 3, // D
      class: 12, // M
      safety: 14, // O
      sku: 17, // R
    };

    const snapshotRows: any[] = [];
    const errors: Array<{ sku: string; stage: string; detail: string }> = [];

    for (const r of rows) {
      const sku = (r?.[COL.sku] || "").toString().trim();
      if (!sku) continue;

      const colorway = (r?.[COL.colorway] || "").toString().trim();
      const size = (r?.[COL.size] || "").toString().trim();
      const classValue = (r?.[COL.class] || "").toString().trim();

      // Parse safety stock
      const safetyStockRaw = r?.[COL.safety];
      const safetyStock = Number(safetyStockRaw || 0) || 0;

      // We still snapshot everything, but weight A/B only
      const classWeight = classValue === "A" ? 2 : classValue === "B" ? 1 : 0;

      // --- Find variant + inventory item by SKU (GraphQL) ---
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

      // --- Depth-aware ratio ---
      // If safety target exists: cap ratio at 1.0
      // If no safety target: 1 if in stock else 0 (temporary)
      const depthRatio =
        safetyStock > 0
          ? Math.min(availableQty / safetyStock, 1)
          : availableQty > 0
          ? 1
          : 0;

      const balanceVsSafety = availableQty - safetyStock;
      const weightedContribution = depthRatio * classWeight;

      snapshotRows.push([
        snapshotDate, // A snapshot_date_et
        snapshotTs, // B snapshot_ts_et
        runId, // C run_id
        sku, // D sku
        colorway, // E colorway
        size, // F size
        classValue, // G class
        safetyStock, // H safety_stock
        variantId, // I shopify_variant_id
        inventoryItemId, // J inventory_item_id
        SHOPIFY_LOCATION_ID, // K location_id
        availableQty, // L available_qty
        balanceVsSafety, // M balance_vs_safety
        depthRatio, // N depth_ratio
        classWeight, // O class_weight
        weightedContribution, // P weighted_contribution
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
      errors: errors.slice(0, 25), // keep response small
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
