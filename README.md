# shopee-plub

Lightweight Shopee Flash Sale monitor using GitHub Actions.

## What this does

This project checks Shopee Thailand Flash Sale public endpoints and writes the current flash sale product list to `shopee-flash-sale.json`.

It is designed as a monitor only:

- no Shopee login
- no captcha bypass
- no auto-buy
- no auto-checkout
- no payment automation

## Files

```text
actions workflow: .github/workflows/check-shopee-vouchers.yml
config file:      flash-sale-config.json
checker script:   scripts/check-shopee-flash-sale.js
output file:      shopee-flash-sale.json
```

## How to use

1. Merge this pull request.
2. Open GitHub Actions.
3. Select `Check Shopee Flash Sale`.
4. Click `Run workflow`.
5. After the run finishes, open `shopee-flash-sale.json`.

The output contains flash sale sessions and product items, including product name, price, original price, discount, stock/sold fields when available, image URL, and product URL.

## Config

Edit `flash-sale-config.json` if needed:

```json
{
  "base_url": "https://shopee.co.th",
  "country": "TH",
  "max_sessions": 4,
  "item_limit": 60,
  "include_sold_out": true,
  "request_delay_ms": 2000
}
```

## Output behavior

The workflow writes results to `shopee-flash-sale.json`. If every Shopee flash sale endpoint fails because of a temporary API/Shopee error and an old output file already exists, the script exits without overwriting the old JSON file.

## Run mode

The workflow is manual-only with `workflow_dispatch`. It will not run on a schedule.

## Local test

```bash
npm run check:flash-sale
```
