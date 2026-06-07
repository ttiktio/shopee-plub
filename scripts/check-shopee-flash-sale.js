const fs = require("fs/promises");

const CONFIG_PATH = "flash-sale-config.json";
const OUTPUT_PATH = "shopee-flash-sale.json";

const DEFAULT_CONFIG = {
  base_url: "https://shopee.co.th",
  country: "TH",
  max_sessions: 4,
  item_limit: 60,
  include_sold_out: true,
  request_delay_ms: 2000,
};

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const RETRIES = Number(process.env.RETRIES || 2);

const USER_AGENT =
  process.env.SHOPEE_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_CONFIG.base_url).replace(/\/+$/, "");
}

function buildUrl(baseUrl, path, params = {}) {
  const url = new URL(path, `${normalizeBaseUrl(baseUrl)}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    return DEFAULT_CONFIG;
  }
}

async function outputExists() {
  try {
    await fs.access(OUTPUT_PATH);
    return true;
  } catch {
    return false;
  }
}

async function fetchJsonWithRetry(url) {
  let lastError;

  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
          "user-agent": USER_AGENT,
          referer: `${new URL(url).origin}/`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt <= RETRIES) {
        await sleep(1000 * attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

async function tryEndpoint(baseUrl, path, params, debug) {
  const url = buildUrl(baseUrl, path, params);

  try {
    const data = await fetchJsonWithRetry(url);
    debug.successful_endpoints.push({ path, params });
    return data;
  } catch (error) {
    debug.endpoint_failures.push({ path, params, error: error.message });
    return null;
  }
}

function asTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;

  return number > 9999999999 ? Math.floor(number / 1000) : Math.floor(number);
}

function toIsoTime(value) {
  const timestamp = asTimestamp(value);
  if (!timestamp) return null;
  return new Date(timestamp * 1000).toISOString();
}

function pickFirst(object, keys) {
  for (const key of keys) {
    if (object && Object.prototype.hasOwnProperty.call(object, key)) {
      const value = object[key];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
  }

  return null;
}

function collectObjects(input, predicate, depth = 0, results = []) {
  if (!input || depth > 10) return results;

  if (Array.isArray(input)) {
    for (const item of input) {
      collectObjects(item, predicate, depth + 1, results);
    }
    return results;
  }

  if (typeof input !== "object") return results;

  if (predicate(input)) {
    results.push(input);
  }

  for (const value of Object.values(input)) {
    collectObjects(value, predicate, depth + 1, results);
  }

  return results;
}

function normalizeSession(raw) {
  const promotionId = pickFirst(raw, [
    "promotionid",
    "promotion_id",
    "promotionId",
    "session_id",
    "sessionid",
    "id",
  ]);

  if (!promotionId) return null;

  const startRaw = pickFirst(raw, ["start_time", "startTime", "start", "start_timestamp"]);
  const endRaw = pickFirst(raw, ["end_time", "endTime", "end", "end_timestamp"]);
  const now = Math.floor(Date.now() / 1000);
  const start = asTimestamp(startRaw);
  const end = asTimestamp(endRaw);

  return {
    promotion_id: String(promotionId),
    name:
      pickFirst(raw, ["name", "session_name", "display_name", "title", "label"]) ||
      null,
    start_time: start,
    start_time_iso: toIsoTime(startRaw),
    end_time: end,
    end_time_iso: toIsoTime(endRaw),
    is_active: Boolean(start && end && now >= start && now <= end),
    raw_status: pickFirst(raw, ["status", "state", "session_status"]),
  };
}

function extractSessions(data) {
  const objects = collectObjects(data, (object) => {
    const keys = Object.keys(object).join(" ").toLowerCase();
    return /promotionid|promotion_id|session_id|sessionid/.test(keys);
  });

  const map = new Map();

  for (const object of objects) {
    const session = normalizeSession(object);
    if (!session) continue;

    if (!map.has(session.promotion_id)) {
      map.set(session.promotion_id, session);
    }
  }

  return [...map.values()].sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    return (a.start_time || 0) - (b.start_time || 0);
  });
}

function normalizePrice(value) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "string" && /[^0-9.]/.test(value)) {
    return value;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) return null;

  if (number >= 100000) {
    return Math.round((number / 100000) * 100) / 100;
  }

  return number;
}

function imageUrl(baseUrl, image) {
  if (!image || typeof image !== "string") return null;
  if (image.startsWith("http")) return image;

  const host = new URL(baseUrl).hostname;
  const prefix = host.includes("shopee.co.th")
    ? "https://down-th.img.susercontent.com/file/"
    : "https://down-ws-sg.img.susercontent.com/file/";

  return `${prefix}${image}`;
}

function normalizeItem(raw, session, baseUrl) {
  const itemId = pickFirst(raw, ["itemid", "item_id", "itemId"]);
  const shopId = pickFirst(raw, ["shopid", "shop_id", "shopId"]);

  if (!itemId || !shopId) return null;

  const name = pickFirst(raw, ["name", "item_name", "title", "display_name"]);
  const price = pickFirst(raw, [
    "price",
    "flash_sale_price",
    "price_min",
    "price_min_before_discount",
  ]);
  const priceBeforeDiscount = pickFirst(raw, [
    "price_before_discount",
    "price_max_before_discount",
    "original_price",
  ]);
  const discount = pickFirst(raw, ["discount", "raw_discount", "discount_text"]);
  const image = pickFirst(raw, ["image", "image_url", "cover", "thumbnail"]);

  return {
    promotion_id: session ? session.promotion_id : null,
    session_name: session ? session.name : null,
    session_start_time_iso: session ? session.start_time_iso : null,
    session_end_time_iso: session ? session.end_time_iso : null,
    shop_id: String(shopId),
    item_id: String(itemId),
    name: name ? String(name) : null,
    price: normalizePrice(price),
    price_before_discount: normalizePrice(priceBeforeDiscount),
    discount: discount === null ? null : String(discount),
    stock: pickFirst(raw, ["stock", "flash_sale_stock", "item_stock"]),
    sold: pickFirst(raw, ["sold", "historical_sold", "flash_sale_sold", "item_sold"]),
    is_sold_out: toBoolean(pickFirst(raw, ["is_sold_out", "soldout", "isSoldOut"]), false),
    image: imageUrl(baseUrl, image),
    url: `${normalizeBaseUrl(baseUrl)}/product/${shopId}/${itemId}`,
  };
}

function extractItems(data, session, baseUrl) {
  const objects = collectObjects(data, (object) => {
    const keys = Object.keys(object).join(" ").toLowerCase();
    return /itemid|item_id|itemid/.test(keys) && /shopid|shop_id|shopid/.test(keys);
  });

  const map = new Map();

  for (const object of objects) {
    const item = normalizeItem(object, session, baseUrl);
    if (!item) continue;

    const key = `${item.shop_id}:${item.item_id}`;
    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

async function fetchSessions(config, debug) {
  const paths = [
    "/api/v4/flash_sale/get_all_sessions",
    "/api/v4/flash_sale/flash_sale_get_all_sessions",
    "/api/v4/flash_sale/get_sessions",
    "/api/v4/flash_sale/flash_sale_get_sessions",
  ];

  for (const path of paths) {
    const data = await tryEndpoint(
      config.base_url,
      path,
      { need_personalize: true, country: config.country },
      debug
    );

    if (!data) continue;

    const sessions = extractSessions(data);
    if (sessions.length > 0) {
      return sessions;
    }
  }

  return [];
}

async function fetchItemsForSession(config, session, debug) {
  const commonParams = {
    promotionid: session.promotion_id,
    limit: config.item_limit,
    offset: 0,
    sort_soldout: config.include_sold_out,
    need_personalize: true,
    with_dp_items: true,
  };

  const endpoints = [
    ["/api/v4/flash_sale/flash_sale_get_items", commonParams],
    ["/api/v4/flash_sale/get_items", commonParams],
    ["/api/v4/flash_sale/flash_sale_batch_get_items", {
      promotionids: session.promotion_id,
      need_personalize: true,
      with_dp_items: true,
    }],
  ];

  for (const [path, params] of endpoints) {
    const data = await tryEndpoint(config.base_url, path, params, debug);
    if (!data) continue;

    const items = extractItems(data, session, config.base_url);
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

async function fetchDirectItems(config, debug) {
  const endpoints = [
    ["/api/v4/flash_sale/flash_sale_get_items", {
      limit: config.item_limit,
      offset: 0,
      sort_soldout: config.include_sold_out,
      need_personalize: true,
    }],
    ["/api/v4/flash_sale/get_items", {
      limit: config.item_limit,
      offset: 0,
      sort_soldout: config.include_sold_out,
      need_personalize: true,
    }],
  ];

  for (const [path, params] of endpoints) {
    const data = await tryEndpoint(config.base_url, path, params, debug);
    if (!data) continue;

    const items = extractItems(data, null, config.base_url);
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

function dedupeItems(items) {
  const map = new Map();

  for (const item of items) {
    const key = `${item.shop_id}:${item.item_id}`;
    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

async function main() {
  const config = await readConfig();
  const debug = {
    successful_endpoints: [],
    endpoint_failures: [],
  };

  console.log("Checking Shopee flash sale products...");

  const sessions = await fetchSessions(config, debug);
  const sessionsToCheck = sessions.slice(0, Number(config.max_sessions || 4));
  const sessionResults = [];
  let allItems = [];

  for (const session of sessionsToCheck) {
    console.log(`Checking flash sale session: ${session.promotion_id}`);
    const items = await fetchItemsForSession(config, session, debug);

    sessionResults.push({
      ...session,
      item_count: items.length,
      items,
    });

    allItems = allItems.concat(items);
    await sleep(Number(config.request_delay_ms || 2000));
  }

  if (allItems.length === 0) {
    const directItems = await fetchDirectItems(config, debug);
    allItems = allItems.concat(directItems);

    if (directItems.length > 0) {
      sessionResults.push({
        promotion_id: null,
        name: "direct_flash_sale_endpoint",
        item_count: directItems.length,
        items: directItems,
      });
    }
  }

  const uniqueItems = dedupeItems(allItems);

  if (debug.successful_endpoints.length === 0 && (await outputExists())) {
    console.error("All Shopee flash sale endpoints failed. Keeping old output unchanged.");
    process.exit(0);
  }

  const output = {
    status: uniqueItems.length > 0 ? "ok" : "no_items",
    source: "shopee_flash_sale_public_api",
    base_url: normalizeBaseUrl(config.base_url),
    country: config.country,
    updated_at: new Date().toISOString(),
    note:
      "Monitor-only output. This script does not login, bypass captcha, auto-buy, checkout, or make payment.",
    sessions_found: sessions.length,
    sessions_checked: sessionsToCheck.length,
    products_found: uniqueItems.length,
    items: uniqueItems,
    sessions: sessionResults,
    debug,
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Updated ${OUTPUT_PATH} with ${uniqueItems.length} item(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
