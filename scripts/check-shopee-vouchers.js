const fs = require("fs/promises");

const PRODUCTS_PATH = "products.json";
const OUTPUT_PATH = "shopee-vouchers.json";

const MAX_PRODUCTS = Number(process.env.MAX_PRODUCTS || 20);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 2500);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const RETRIES = Number(process.env.RETRIES || 2);

const USER_AGENT =
  process.env.SHOPEE_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractShopeeIds(url) {
  const text = decodeURIComponent(String(url || ""));

  // Example: https://shopee.co.th/product/123456/789012
  let match = text.match(/\/product\/(\d+)\/(\d+)/i);
  if (match) {
    return { shopId: match[1], itemId: match[2] };
  }

  // Example: https://shopee.co.th/name-i.123456.789012
  match = text.match(/(?:^|[^a-z0-9])i\.(\d+)\.(\d+)/i);
  if (match) {
    return { shopId: match[1], itemId: match[2] };
  }

  // Fallback: use the last two large dot-separated numbers in the URL.
  const pairs = [...text.matchAll(/\.(\d{4,})\.(\d{4,})(?:[/?#]|$)/g)];
  const last = pairs[pairs.length - 1];
  if (last) {
    return { shopId: last[1], itemId: last[2] };
  }

  return null;
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
          referer: "https://shopee.co.th/",
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

function pickFields(object) {
  const usefulKeys = [
    "voucher_code",
    "voucherCode",
    "code",
    "promotion_id",
    "promotionid",
    "voucher_id",
    "voucherid",
    "discount_percentage",
    "discount_percent",
    "discount_value",
    "discount_amount",
    "discount",
    "min_spend",
    "minSpend",
    "minimum_spend",
    "reward_type",
    "start_time",
    "end_time",
    "use_type",
    "voucher_type",
    "shopid",
    "itemid",
    "display_name",
    "label",
    "title",
  ];

  const result = {};

  for (const key of usefulKeys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
      const value = object[key];
      if (value === null || value === undefined) continue;

      if (typeof value === "object") {
        result[key] = JSON.stringify(value).slice(0, 300);
      } else {
        result[key] = String(value).slice(0, 300);
      }
    }
  }

  return result;
}

function collectVoucherCandidates(input, path = "$", depth = 0, results = []) {
  if (!input || depth > 8 || results.length >= 50) return results;

  if (Array.isArray(input)) {
    input.forEach((item, index) => {
      collectVoucherCandidates(item, `${path}[${index}]`, depth + 1, results);
    });
    return results;
  }

  if (typeof input !== "object") return results;

  const keys = Object.keys(input);
  const joinedKeys = keys.join(" ").toLowerCase();
  const pathLooksRelevant = /voucher|coupon|promotion|discount/.test(path.toLowerCase());
  const keysLookRelevant = /voucher|coupon|promotion|discount|min_spend|reward/.test(joinedKeys);

  if (pathLooksRelevant || keysLookRelevant) {
    const fields = pickFields(input);
    if (Object.keys(fields).length > 0) {
      results.push({ path, fields });
    }
  }

  for (const key of keys) {
    collectVoucherCandidates(input[key], `${path}.${key}`, depth + 1, results);
  }

  return results;
}

async function checkProduct(product) {
  const ids = extractShopeeIds(product.url);

  if (!ids) {
    return {
      name: product.name || "Unnamed product",
      url: product.url,
      status: "skipped",
      reason: "Cannot extract shop_id and item_id from URL",
      voucher_candidates: [],
    };
  }

  const apiUrl =
    `https://shopee.co.th/api/v4/pdp/get_pc?shop_id=${ids.shopId}&item_id=${ids.itemId}`;

  const data = await fetchJsonWithRetry(apiUrl);
  const candidates = collectVoucherCandidates(data);

  return {
    name: product.name || "Unnamed product",
    url: product.url,
    shop_id: ids.shopId,
    item_id: ids.itemId,
    status: "ok",
    voucher_candidate_count: candidates.length,
    voucher_candidates: candidates,
  };
}

async function main() {
  const raw = await fs.readFile(PRODUCTS_PATH, "utf8");
  const products = JSON.parse(raw);

  const enabledProducts = products
    .filter((product) => product && product.enabled !== false)
    .slice(0, MAX_PRODUCTS);

  if (enabledProducts.length === 0) {
    const output = {
      status: "idle",
      source: PRODUCTS_PATH,
      updated_at: new Date().toISOString(),
      message: "No enabled products. Add Shopee product URLs in products.json and set enabled to true.",
      products_checked: 0,
      total_voucher_candidates: 0,
      items: [],
    };

    await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
    console.log("No enabled products. Wrote idle output.");
    return;
  }

  const items = [];
  const failures = [];

  for (const product of enabledProducts) {
    try {
      console.log(`Checking: ${product.name || product.url}`);
      const result = await checkProduct(product);
      items.push(result);
    } catch (error) {
      failures.push({
        name: product.name || "Unnamed product",
        url: product.url,
        error: error.message,
      });
      console.error(`Failed: ${product.name || product.url}`);
      console.error(error.message);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  const successfulChecks = items.filter((item) => item.status === "ok").length;

  if (successfulChecks === 0 && failures.length > 0) {
    console.error("All enabled product checks failed. Keeping old shopee-vouchers.json unchanged.");
    process.exit(0);
  }

  const output = {
    status: failures.length > 0 ? "partial" : "ok",
    source: PRODUCTS_PATH,
    updated_at: new Date().toISOString(),
    note:
      "Monitor-only output. This script does not login, bypass captcha, auto-buy, or checkout.",
    products_checked: items.length,
    failed_products: failures.length,
    total_voucher_candidates: items.reduce(
      (total, item) => total + (item.voucher_candidate_count || 0),
      0
    ),
    items,
    failures,
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Updated ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
