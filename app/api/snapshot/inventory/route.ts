import { NextResponse } from "next/server";
import { google } from "googleapis";

const TZ = "America/New_York";

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

export async function GET(req: Request) {
  // --- Security check ---
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const snapshotDate = getETDate();
  const snapshotTs = getETTimestamp();
  const runId = `${snapshotDate}-${Date.now()}`;

  // --- Google Sheets auth ---
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    undefined,
    process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]
  );

  const sheets = google.sheets({ version: "v4", auth });

  // --- Read SKU definitions ---
  const skuSheet = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID!,
    range: "Summary!A2:Z",
  });

  const rows = skuSheet.data.values || [];

  // Column indexes (0-based)
  const COL = {
    colorway: 2, // C
    size: 3,     // D
    class: 12,   // M
    safety: 14,  // O
    sku: 17,     // R
  };

  // --- Shopify headers ---
  const shopifyHeaders = {
    "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN!,
    "Content-Type": "application/json",
  };

  const snapshotRows: any[] = [];

  for (const r of rows) {
    const sku = r[COL.sku];
    if (!sku) continue;

    const safetyStock = Number(r[COL.safety] || 0);
    const classValue = r[COL.class] || "";
    const classWeight = classValue === "A" ? 2 : classValue === "B" ? 1 : 0;

    // --- Get variant by SKU ---
    const variantRes = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_API_VERSION}/variants.json?sku=${encodeURIComponent(
        sku
      )}`,
      { headers: shopifyHeaders }
    );

    const variantJson = await variantRes.json();
    const variant = variantJson.variants?.[0];
    if (!variant) continue;

    const inventoryItemId = variant.inventory_item_id;

    // --- Get inventory level ---
    const invRes = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_API_VERSION}/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${process.env.SHOPIFY_LOCATION_ID}`,
      { headers: shopifyHeaders }
    );

    const invJson = await invRes.json();
    const availableQty = invJson.inventory_levels?.[0]?.available ?? 0;

    const depthRatio =
      safetyStock > 0
        ? Math.min(availableQty / safetyStock, 1)
        : availableQty > 0
        ? 1
        : 0;

    snapshotRows.push([
      snapshotDate,
      snapshotTs,
      runId,
      sku,
      r[COL.colorway],
      r[COL.size],
      classValue,
      safetyStock,
      variant.id,
      inventoryItemId,
      process.env.SHOPIFY_LOCATION_ID,
      availableQty,
      availableQty - safetyStock,
      depthRatio,
      classWeight,
      depthRatio * classWeight,
    ]);
  }

  // --- Append rows ---
  if (snapshotRows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID!,
      range: "inventory_snapshots!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: snapshotRows,
      },
    });
  }

  return NextResponse.json({
    status: "ok",
    rowsInserted: snapshotRows.length,
    snapshotDate,
  });
}