"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";

// -----------------------------
// Mock API + endpoint swap area
// -----------------------------
// Replace these with real endpoints later.
// Example:
// const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
// const ENDPOINTS = {
//   summary: `${API_BASE}/api/summary`,
//   inventoryIndex: `${API_BASE}/api/inventory/index`,
//   trends: `${API_BASE}/api/trends`,
//   inventory: `${API_BASE}/api/inventory/drilldown`,
//   marketing: `${API_BASE}/api/marketing`,
// };

type DateRangeKey = "today" | "yesterday" | "last7" | "last30" | "custom";

type Kpi = {
  key:
    | "grossSales"
    | "netSales"
    | "orders"
    | "marketingSpend"
    | "mer"
    | "conversionRate";
  label: string;
  value: string;
  deltaPct: number;
  spark: { x: string; y: number }[];
};

type SummaryPayload = {
  lastUpdatedISO: string;
  kpis: Kpi[];
};

type InventoryIndexPayload = {
  score: number; // 0-100
  series: { date: string; index: number }[];
  aAvailabilityPct: number;
  bAvailabilityPct: number;
  topMoversInStock: number;
  criticalMissingSkus: number;
};

type TrendsPayload = {
  indexVsCvr: { date: string; index: number; cvr: number }[];
  salesVsSpend: { date: string; grossSales: number; spend: number }[];
  rollingCorrelation30d: number;
};

type InventoryRow = {
  sku: string;
  product: string;
  colorway: string;
  class: "A" | "B" | "C" | "LE";
  size: "YTH-MD" | "YTH-LG" | "YTH-XL" | "SR-SM" | "SR-MD" | "SR-LG";
  onHand: number;
  safetyStock: number;
  health: "OK" | "Low" | "Out";
  shopifyUrl?: string;
};

type InventoryPayload = {
  rows: InventoryRow[];
};

type MarketingPayload = {
  spendByChannel: { channel: "Meta" | "Google"; spend: number }[];
  merTrend: { date: string; mer: number }[];
  note: string;
};

// Mock data builders
function buildSpark(seed = 1): { x: string; y: number }[] {
  const points = 12;
  const out: { x: string; y: number }[] = [];
  let v = 50 + seed * 3;
  for (let i = 0; i < points; i += 1) {
    v = Math.max(0, v + ((i % 2 === 0 ? 1 : -1) * (3 + (seed % 5))));
    out.push({ x: String(i + 1), y: Math.round(v) });
  }
  return out;
}

function mockSummary(range: DateRangeKey): SummaryPayload {
  const now = new Date();
  const lastUpdatedISO = now.toISOString();

  const factor =
    range === "today" ? 1 : range === "yesterday" ? 0.92 : range === "last7" ? 1.08 : range === "last30" ? 1.02 : 1;

  const fmtUSD = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

  const gross = 84500 * factor;
  const net = 73100 * factor;
  const spend = 18200 * factor;
  const orders = Math.round(612 * factor);
  const mer = gross / Math.max(1, spend);
  const cvr = 0.072 * (range === "today" ? 1 : range === "yesterday" ? 0.95 : 1.03);

  const kpis: Kpi[] = [
    {
      key: "grossSales",
      label: "Gross Sales",
      value: fmtUSD(gross),
      deltaPct: 6.4,
      spark: buildSpark(1),
    },
    {
      key: "netSales",
      label: "Net Sales",
      value: fmtUSD(net),
      deltaPct: 4.9,
      spark: buildSpark(2),
    },
    {
      key: "orders",
      label: "Orders",
      value: orders.toLocaleString("en-US"),
      deltaPct: 2.1,
      spark: buildSpark(3),
    },
    {
      key: "marketingSpend",
      label: "Marketing Spend",
      value: fmtUSD(spend),
      deltaPct: -3.2,
      spark: buildSpark(4),
    },
    {
      key: "mer",
      label: "MER",
      value: mer.toFixed(2),
      deltaPct: 10.2,
      spark: buildSpark(5),
    },
    {
      key: "conversionRate",
      label: "Conversion Rate",
      value: `${(cvr * 100).toFixed(2)}%`,
      deltaPct: 1.4,
      spark: buildSpark(6),
    },
  ];

  return { lastUpdatedISO, kpis };
}

function mockInventoryIndex(range: DateRangeKey): InventoryIndexPayload {
  const days = range === "last30" ? 30 : range === "last7" ? 7 : 14;
  const today = new Date();

  const series = Array.from({ length: days }).map((_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (days - 1 - i));
    const base = 78 + Math.sin(i / 2.5) * 10;
    const index = Math.max(0, Math.min(100, Math.round(base + (i % 6 === 0 ? -14 : 0))));
    return { date: d.toISOString().slice(0, 10), index };
  });

  const score = series[series.length - 1]?.index ?? 75;

  const aAvailabilityPct = Math.max(0, Math.min(100, 92 - (range === "yesterday" ? 3 : 0)));
  const bAvailabilityPct = Math.max(0, Math.min(100, 84 + (range === "last7" ? 2 : 0)));

  return {
    score,
    series,
    aAvailabilityPct,
    bAvailabilityPct,
    topMoversInStock: 47,
    criticalMissingSkus: 6,
  };
}

function mockTrends(range: DateRangeKey): TrendsPayload {
  const days = range === "last30" ? 30 : range === "last7" ? 7 : 14;
  const today = new Date();

  const indexVsCvr = Array.from({ length: days }).map((_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (days - 1 - i));
    const idx = Math.max(0, Math.min(100, Math.round(76 + Math.sin(i / 2.3) * 12 + (i % 9 === 0 ? -16 : 0))));
    const cvr = Math.max(0, 0.012 + (idx / 100) * 0.09 + (i % 11 === 0 ? -0.012 : 0));
    return { date: d.toISOString().slice(0, 10), index: idx, cvr: Number((cvr * 100).toFixed(2)) };
  });

  const salesVsSpend = Array.from({ length: days }).map((_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (days - 1 - i));
    const grossSales = Math.max(0, Math.round(68000 + Math.sin(i / 2.1) * 18000 + (i % 10 === 0 ? -16000 : 0)));
    const spend = Math.max(0, Math.round(14000 + Math.cos(i / 2.5) * 4200));
    return { date: d.toISOString().slice(0, 10), grossSales, spend };
  });

  return {
    indexVsCvr,
    salesVsSpend,
    rollingCorrelation30d: 0.71,
  };
}

function mockInventory(): InventoryPayload {
  const rows: InventoryRow[] = [
    {
      sku: "CRBL-BLK-YTHMD",
      product: "Cut-Resistant Baselayer",
      colorway: "Black",
      class: "A",
      size: "YTH-MD",
      onHand: 38,
      safetyStock: 30,
      health: "OK",
    },
    {
      sku: "CRBL-BLK-SRMD",
      product: "Cut-Resistant Baselayer",
      colorway: "Black",
      class: "A",
      size: "SR-MD",
      onHand: 6,
      safetyStock: 25,
      health: "Low",
    },
    {
      sku: "CRBL-NVY-SRLG",
      product: "Cut-Resistant Baselayer",
      colorway: "Navy",
      class: "B",
      size: "SR-LG",
      onHand: 0,
      safetyStock: 18,
      health: "Out",
    },
    {
      sku: "CRBL-WHT-YTHLG",
      product: "Cut-Resistant Baselayer",
      colorway: "White",
      class: "B",
      size: "YTH-LG",
      onHand: 22,
      safetyStock: 20,
      health: "OK",
    },
    {
      sku: "CRBL-RED-YTHXL",
      product: "Cut-Resistant Baselayer",
      colorway: "Red",
      class: "C",
      size: "YTH-XL",
      onHand: 9,
      safetyStock: 12,
      health: "Low",
    },
    {
      sku: "CRBL-LE-GRN-SRSM",
      product: "Cut-Resistant Baselayer",
      colorway: "LE Green",
      class: "LE",
      size: "SR-SM",
      onHand: 0,
      safetyStock: 0,
      health: "Out",
    },
  ];

  return { rows };
}

function mockMarketing(range: DateRangeKey): MarketingPayload {
  const days = range === "last30" ? 30 : range === "last7" ? 7 : 14;
  const today = new Date();

  const spendByChannel = [
    { channel: "Meta" as const, spend: 10240 },
    { channel: "Google" as const, spend: 7960 },
  ];

  const merTrend = Array.from({ length: days }).map((_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (days - 1 - i));
    const mer = Math.max(0.5, 3.2 + Math.sin(i / 2.7) * 0.6 + (i % 13 === 0 ? -0.7 : 0));
    return { date: d.toISOString().slice(0, 10), mer: Number(mer.toFixed(2)) };
  });

  return {
    spendByChannel,
    merTrend,
    note: "Spend data sourced from Lebesgue (aggregated Meta and Google).",
  };
}

// -----------------------------
// UI helpers
// -----------------------------
function classNames(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

function formatIsoToLocal(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusFromIndex(score: number): { label: "Green" | "Yellow" | "Red"; tone: string; note: string } {
  if (score >= 80) return { label: "Green", tone: "bg-emerald-50 text-emerald-800 border-emerald-200", note: "Inventory supports scale." };
  if (score >= 60) return { label: "Yellow", tone: "bg-amber-50 text-amber-800 border-amber-200", note: "Watch top SKUs and sizes." };
  return { label: "Red", tone: "bg-rose-50 text-rose-800 border-rose-200", note: "Inventory constrained. Expect conversion pressure." };
}

function deltaTone(deltaPct: number) {
  if (deltaPct > 0) return "text-emerald-700";
  if (deltaPct < 0) return "text-rose-700";
  return "text-slate-600";
}

function healthBadge(health: InventoryRow["health"]) {
  if (health === "OK") return "bg-emerald-50 text-emerald-800 border-emerald-200";
  if (health === "Low") return "bg-amber-50 text-amber-800 border-amber-200";
  return "bg-rose-50 text-rose-800 border-rose-200";
}

// -----------------------------
// Components
// -----------------------------
function Skeleton({ className }: { className?: string }) {
  return <div className={classNames("animate-pulse rounded-xl bg-slate-100", className)} />;
}

function Card({
  title,
  children,
  right,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={classNames("rounded-2xl border border-slate-200 bg-white shadow-sm", className)}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          {title ? <h3 className="text-sm font-semibold text-slate-900">{title}</h3> : <div />}
          {right}
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function KpiCard({ kpi, loading }: { kpi: Kpi; loading: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-slate-600">{kpi.label}</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">
            {loading ? <Skeleton className="h-7 w-28" /> : kpi.value}
          </div>
          <div className={classNames("mt-1 text-xs font-medium", deltaTone(kpi.deltaPct))}>
            {loading ? (
              <Skeleton className="h-4 w-24" />
            ) : (
              <span>
                {kpi.deltaPct > 0 ? "▲" : kpi.deltaPct < 0 ? "▼" : "■"} {Math.abs(kpi.deltaPct).toFixed(1)}% vs previous
              </span>
            )}
          </div>
        </div>
        <div className="h-10 w-16">
          {loading ? (
            <Skeleton className="h-10 w-16" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={kpi.spark}>
                <Line type="monotone" dataKey="y" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

function RangeSelect({ value, onChange }: { value: DateRangeKey; onChange: (v: DateRangeKey) => void }) {
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only">Date range</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DateRangeKey)}
        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-200"
      >
        <option value="today">Today</option>
        <option value="yesterday">Yesterday</option>
        <option value="last7">Last 7 days</option>
        <option value="last30">Last 30 days</option>
        <option value="custom">Custom</option>
      </select>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: string }) {
  return <span className={classNames("inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold", tone)}>{children}</span>;
}

function Button({ children, variant = "primary" }: { children: React.ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <button
      type="button"
      className={classNames(
        "rounded-xl px-3 py-2 text-sm font-semibold shadow-sm",
        variant === "primary"
          ? "bg-slate-900 text-white hover:bg-slate-800"
          : "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
      )}
    >
      {children}
    </button>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
      <div className="text-sm font-semibold text-slate-900">{title}</div>
      <div className="mt-1 text-sm text-slate-600">{description}</div>
    </div>
  );
}

type Filters = {
  class: "All" | "A" | "B" | "C" | "LE";
  size: "All" | InventoryRow["size"];
  stock: "All" | "In stock" | "Out of stock" | "Below safety stock";
  q: string;
};

function FiltersBar({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-xs font-medium text-slate-600">Class</div>
          <select
            value={filters.class}
            onChange={(e) => onChange({ ...filters, class: e.target.value as Filters["class"] })}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm"
          >
            <option value="All">All</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
            <option value="LE">LE</option>
          </select>
        </div>
        <div>
          <div className="text-xs font-medium text-slate-600">Size</div>
          <select
            value={filters.size}
            onChange={(e) => onChange({ ...filters, size: e.target.value as Filters["size"] })}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm"
          >
            <option value="All">All</option>
            <option value="YTH-MD">YTH-MD</option>
            <option value="YTH-LG">YTH-LG</option>
            <option value="YTH-XL">YTH-XL</option>
            <option value="SR-SM">SR-SM</option>
            <option value="SR-MD">SR-MD</option>
            <option value="SR-LG">SR-LG</option>
          </select>
        </div>
        <div>
          <div className="text-xs font-medium text-slate-600">Stock status</div>
          <select
            value={filters.stock}
            onChange={(e) => onChange({ ...filters, stock: e.target.value as Filters["stock"] })}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm"
          >
            <option value="All">All</option>
            <option value="In stock">In stock</option>
            <option value="Out of stock">Out of stock</option>
            <option value="Below safety stock">Below safety stock</option>
          </select>
        </div>
        <div>
          <div className="text-xs font-medium text-slate-600">Search</div>
          <input
            value={filters.q}
            onChange={(e) => onChange({ ...filters, q: e.target.value })}
            placeholder="SKU or product"
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm"
          />
        </div>
      </div>
    </div>
  );
}

function InventoryTable({ rows, loading }: { rows: InventoryRow[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState title="No inventory rows" description="Try changing filters or your date range." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] border-separate border-spacing-y-2">
        <thead>
          <tr className="text-left text-xs font-semibold text-slate-600">
            <th className="px-3 py-2">SKU</th>
            <th className="px-3 py-2">Product / Colorway</th>
            <th className="px-3 py-2">Class</th>
            <th className="px-3 py-2">Size</th>
            <th className="px-3 py-2">On-hand</th>
            <th className="px-3 py-2">Safety stock</th>
            <th className="px-3 py-2">Stock health</th>
            <th className="px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.sku}-${r.size}`} className="rounded-xl bg-slate-50">
              <td className="rounded-l-xl px-3 py-3 text-sm font-medium text-slate-900">{r.sku}</td>
              <td className="px-3 py-3 text-sm text-slate-700">
                <div className="font-medium text-slate-900">{r.product}</div>
                <div className="text-xs text-slate-600">{r.colorway}</div>
              </td>
              <td className="px-3 py-3 text-sm text-slate-700">
                <Badge tone="bg-white text-slate-800 border-slate-200">{r.class}</Badge>
              </td>
              <td className="px-3 py-3 text-sm text-slate-700">{r.size}</td>
              <td className="px-3 py-3 text-sm text-slate-700">{r.onHand}</td>
              <td className="px-3 py-3 text-sm text-slate-700">{r.safetyStock}</td>
              <td className="px-3 py-3 text-sm text-slate-700">
                <Badge tone={healthBadge(r.health)}>{r.health}</Badge>
              </td>
              <td className="rounded-r-xl px-3 py-3 text-sm text-slate-700">
                <div className="flex items-center gap-2">
                  <a
                    href={r.shopifyUrl ?? "#"}
                    className="text-sm font-semibold text-slate-900 underline decoration-slate-300 underline-offset-4 hover:decoration-slate-600"
                    onClick={(e) => {
                      if (!r.shopifyUrl) e.preventDefault();
                    }}
                  >
                    Open in Shopify
                  </a>
                  <Button variant="secondary">Create reorder task</Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionCenter() {
  const items = [
    {
      priority: "High" as const,
      title: "Index below 60",
      desc: "Reduce prospecting spend, focus retargeting until A SKUs recover.",
    },
    {
      priority: "High" as const,
      title: "A SKUs missing in SR-MD and SR-LG",
      desc: "Reorder immediately and suppress ads to those variants to protect conversion.",
    },
    {
      priority: "Medium" as const,
      title: "Index healthy but MER dropping",
      desc: "Audit campaigns, landing pages, and offer positioning.",
    },
    {
      priority: "Low" as const,
      title: "B SKUs below safety stock",
      desc: "Plan replenishment to prevent index sliding next week.",
    },
  ];

  const tone = (p: string) => {
    if (p === "High") return "bg-rose-50 text-rose-800 border-rose-200";
    if (p === "Medium") return "bg-amber-50 text-amber-800 border-amber-200";
    return "bg-slate-50 text-slate-800 border-slate-200";
  };

  return (
    <Card title="Action Center">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items.map((it) => (
          <div key={it.title} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">{it.title}</div>
                <div className="mt-1 text-sm text-slate-600">{it.desc}</div>
              </div>
              <Badge tone={tone(it.priority)}>{it.priority}</Badge>
            </div>
            <div className="mt-3">
              <Button>View details</Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ChartCard({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return <Card title={title} right={right}>{children}</Card>;
}

function formatCompactUSD(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export default function TitanExecDashboardPage() {
  const [range, setRange] = useState<DateRangeKey>("last7");
  const [loading, setLoading] = useState(true);

  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [invIndex, setInvIndex] = useState<InventoryIndexPayload | null>(null);
  const [trends, setTrends] = useState<TrendsPayload | null>(null);
  const [inventory, setInventory] = useState<InventoryPayload | null>(null);
  const [marketing, setMarketing] = useState<MarketingPayload | null>(null);

  const [filters, setFilters] = useState<Filters>({ class: "All", size: "All", stock: "All", q: "" });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Simulated fetch delay. Replace with real fetch calls later.
    const t = setTimeout(() => {
      if (cancelled) return;
      setSummary(mockSummary(range));
      setInvIndex(mockInventoryIndex(range));
      setTrends(mockTrends(range));
      setInventory(mockInventory());
      setMarketing(mockMarketing(range));
      setLoading(false);
    }, 650);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [range]);

  const invStatus = useMemo(() => {
    const score = invIndex?.score ?? 0;
    return statusFromIndex(score);
  }, [invIndex]);

  const filteredRows = useMemo(() => {
    const rows = inventory?.rows ?? [];
    return rows.filter((r) => {
      if (filters.class !== "All" && r.class !== filters.class) return false;
      if (filters.size !== "All" && r.size !== filters.size) return false;
      if (filters.stock !== "All") {
        const inStock = r.onHand > 0;
        const belowSafety = r.safetyStock > 0 && r.onHand > 0 && r.onHand < r.safetyStock;
        if (filters.stock === "In stock" && !inStock) return false;
        if (filters.stock === "Out of stock" && inStock) return false;
        if (filters.stock === "Below safety stock" && !belowSafety) return false;
      }
      if (filters.q.trim()) {
        const q = filters.q.trim().toLowerCase();
        const hay = `${r.sku} ${r.product} ${r.colorway}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [inventory, filters]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sticky Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 md:px-6">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-slate-900" />
            <div>
              <div className="text-sm font-semibold text-slate-900">Titan Exec Dashboard</div>
              <div className="text-xs text-slate-600">Performance drivers and actions</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <RangeSelect value={range} onChange={setRange} />
            <div className="hidden text-right text-xs text-slate-600 sm:block">
              <div className="font-medium text-slate-800">Last updated</div>
              <div>{summary ? formatIsoToLocal(summary.lastUpdatedISO) : "—"}</div>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">
        {/* KPI Row */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Executive Summary</h2>
            <div className="text-xs text-slate-600 sm:hidden">Last updated: {summary ? formatIsoToLocal(summary.lastUpdatedISO) : "—"}</div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {(summary?.kpis ?? Array.from({ length: 6 }).map((_, i) => ({
              key: String(i) as any,
              label: "Loading",
              value: "—",
              deltaPct: 0,
              spark: [],
            })))
              .slice(0, 6)
              .map((kpi, idx) => (
                <KpiCard key={`${kpi.key}-${idx}`} kpi={kpi as Kpi} loading={loading} />
              ))}
          </div>
        </section>

        {/* Inventory Index */}
        <section className="mt-6">
          <div className="grid grid-cols-1 gap-3">
            <Card
              title="Inventory Position Index"
              right={
                <div className="flex items-center gap-2">
                  <Badge tone={invStatus.tone}>{invStatus.label}</Badge>
                </div>
              }
              className="border-slate-200"
            >
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                <div className="lg:col-span-4">
                  <div className="text-xs font-medium text-slate-600">Current score</div>
                  <div className="mt-1 text-4xl font-semibold text-slate-900">
                    {loading ? <Skeleton className="h-10 w-28" /> : invIndex?.score ?? "—"}
                    <span className="ml-2 text-base font-semibold text-slate-500">/ 100</span>
                  </div>
                  <div className="mt-2 text-sm text-slate-600">{invStatus.note}</div>

                  <div className="mt-5 grid grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-slate-200 bg-white p-3">
                      <div className="text-xs font-medium text-slate-600">Top movers in stock</div>
                      <div className="mt-1 text-xl font-semibold text-slate-900">
                        {loading ? <Skeleton className="h-6 w-16" /> : invIndex?.topMoversInStock ?? "—"}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-3">
                      <div className="text-xs font-medium text-slate-600">Critical missing SKUs</div>
                      <div className="mt-1 text-xl font-semibold text-slate-900">
                        {loading ? <Skeleton className="h-6 w-16" /> : invIndex?.criticalMissingSkus ?? "—"}
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-sm font-semibold text-slate-900">Availability breakdown</div>
                    <div className="mt-3 grid grid-cols-1 gap-3">
                      <div>
                        <div className="flex items-center justify-between text-xs text-slate-600">
                          <span>A SKU Availability</span>
                          <span className="font-semibold text-slate-900">{loading ? "—" : `${invIndex?.aAvailabilityPct ?? 0}%`}</span>
                        </div>
                        <div className="mt-2 h-2 w-full rounded-full bg-slate-100">
                          <div
                            className="h-2 rounded-full bg-slate-900"
                            style={{ width: `${loading ? 0 : invIndex?.aAvailabilityPct ?? 0}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between text-xs text-slate-600">
                          <span>B SKU Availability</span>
                          <span className="font-semibold text-slate-900">{loading ? "—" : `${invIndex?.bAvailabilityPct ?? 0}%`}</span>
                        </div>
                        <div className="mt-2 h-2 w-full rounded-full bg-slate-100">
                          <div
                            className="h-2 rounded-full bg-slate-700"
                            style={{ width: `${loading ? 0 : invIndex?.bAvailabilityPct ?? 0}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-8">
                  <div className="text-xs font-medium text-slate-600">Index over time</div>
                  <div className="mt-2 h-56 w-full">
                    {loading ? (
                      <Skeleton className="h-56 w-full" />
                    ) : invIndex && invIndex.series.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={invIndex.series}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                          <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                          <Tooltip />
                          <Line type="monotone" dataKey="index" strokeWidth={2} dot={false} name="Index" />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <EmptyState title="No index data" description="Once backend is connected, index history will appear here." />
                    )}
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </section>

        {/* Driver Trends */}
        <section className="mt-6">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <ChartCard
              title="Index vs Conversion Rate"
              right={
                <div className="text-xs text-slate-600">
                  Rolling 30-day corr: <span className="font-semibold text-slate-900">{trends ? trends.rollingCorrelation30d.toFixed(2) : "—"}</span>
                </div>
              }
            >
              <div className="h-64">
                {loading ? (
                  <Skeleton className="h-64 w-full" />
                ) : trends && trends.indexVsCvr.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trends.indexVsCvr}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="left" domain={[0, 100]} tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="right" orientation="right" domain={[0, "auto"]} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      <Line yAxisId="left" type="monotone" dataKey="index" strokeWidth={2} dot={false} name="Index" />
                      <Line yAxisId="right" type="monotone" dataKey="cvr" strokeWidth={2} dot={false} name="Conversion rate (%)" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState title="No trend data" description="Connect backend to visualize trends." />
                )}
              </div>
            </ChartCard>

            <ChartCard title="Sales and Spend">
              <div className="h-64">
                {loading ? (
                  <Skeleton className="h-64 w-full" />
                ) : trends && trends.salesVsSpend.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trends.salesVsSpend}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(value: any, name: any) => (name === "Spend" || name === "Gross Sales" ? formatCompactUSD(Number(value)) : value)} />
                      <Legend />
                      <Line type="monotone" dataKey="grossSales" strokeWidth={2} dot={false} name="Gross Sales" />
                      <Line type="monotone" dataKey="spend" strokeWidth={2} dot={false} name="Spend" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState title="No sales/spend data" description="Connect backend to visualize sales and spend." />
                )}
              </div>
            </ChartCard>
          </div>
        </section>

        {/* Action Center */}
        <section className="mt-6">
          <ActionCenter />
        </section>

        {/* Inventory Drilldown */}
        <section className="mt-6">
          <Card title="Inventory Drilldown">
            <FiltersBar filters={filters} onChange={setFilters} />
            <div className="mt-4">
              <InventoryTable rows={filteredRows} loading={loading} />
            </div>
          </Card>
        </section>

        {/* Marketing Efficiency */}
        <section className="mt-6">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <ChartCard title="Spend by channel">
              <div className="h-56">
                {loading ? (
                  <Skeleton className="h-56 w-full" />
                ) : marketing && marketing.spendByChannel.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={marketing.spendByChannel}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="channel" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v: any) => formatCompactUSD(Number(v))} />
                      <Bar dataKey="spend" name="Spend" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState title="No marketing data" description="Connect Lebesgue export/API to populate spend." />
                )}
              </div>
              <div className="mt-3 text-xs text-slate-600">{marketing?.note ?? "Spend data sourced from Lebesgue."}</div>
            </ChartCard>

            <ChartCard title="MER trend">
              <div className="h-56">
                {loading ? (
                  <Skeleton className="h-56 w-full" />
                ) : marketing && marketing.merTrend.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={marketing.merTrend}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Line type="monotone" dataKey="mer" strokeWidth={2} dot={false} name="MER" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState title="No MER data" description="Connect backend to compute or import MER." />
                )}
              </div>
            </ChartCard>
          </div>
        </section>

        {/* Footer / README hint */}
        <section className="mt-8">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-700 shadow-sm">
            <div className="text-sm font-semibold text-slate-900">Backend connection guide</div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-600">
              <li>Replace mock data functions with real fetch calls to your API endpoints.</li>
              <li>Keep payload shapes the same as the TypeScript types near the top of this file.</li>
              <li>Wire filters to your inventory drilldown endpoint for server-side pagination if needed.</li>
            </ol>
          </div>
        </section>
      </main>
    </div>
  );
}
