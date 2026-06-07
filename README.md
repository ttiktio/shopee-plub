# shopee-plub

Lightweight Shopee voucher monitor using GitHub Actions.

## What this does

This project checks a list of Shopee product URLs from `products.json`, looks for voucher-related data in the public product response, and writes the result to `shopee-vouchers.json`.

It is designed as a monitor only:

- no Shopee login
- no captcha bypass
- no auto-buy
- no auto-checkout
- no payment automation

## Files

```text
actions workflow: .github/workflows/check-shopee-vouchers.yml
product list:     products.json
checker script:   scripts/check-shopee-vouchers.js
output file:      shopee-vouchers.json
```

## How to use

1. Open `products.json`.
2. Replace the example URL with a real Shopee product URL.
3. Set `enabled` to `true`.
4. Run the workflow manually from GitHub Actions, or wait for the schedule.

Example:

```json
[
  {
    "name": "Golf ball shop example",
    "url": "https://shopee.co.th/example-product-i.123456.789012",
    "enabled": true
  }
]
```

## Output

The workflow updates `shopee-vouchers.json` only when it can successfully check at least one enabled product. If every enabled product fails because of a temporary Shopee/API error, the script exits without overwriting the old JSON file.

## Schedule

The workflow runs every 10 minutes and can also be run manually with `workflow_dispatch`.

## Local test

```bash
npm run check:vouchers
```
