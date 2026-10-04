# Tool reference

Generated from the server's own `tools/list` and from calls against the synthetic test catalog in `tests/`, so the example values are made up and live prices differ. Every tool is public (no key), read-only (`readOnlyHint: true`), and returns both `structuredContent` (matching the output schema below) and the same JSON as text.

- [`search_esim_plans`](#search_esim_plans): Search eSIM plans
- [`compare_country_plans`](#compare_country_plans): Compare plans by country
- [`get_country_networks`](#get_country_networks): Get mobile networks for a country
- [`calculate_safari_data`](#calculate_safari_data): Estimate trip data needs
- [`list_destinations`](#list_destinations): List destinations

## `search_esim_plans`

**Search eSIM plans.** Find travel eSIM plans that work in every country of a trip, cheapest first. Use it for questions like "best eSIM for a 10-day Kenya safari" or "one eSIM for Kenya, Tanzania and Uganda under $40". Each plan includes its data allowance (or unlimited with its daily full-speed cap), validity, price in the requested currency, the operators it uses in those countries, and a checkout_url. Prices are live and match Safari eSIM checkout. If no single plan covers every country, use compare_country_plans.

### Input

| Field | Type | Required | Notes |
|---|---|---|---|
| `countries` | string[] | yes | Countries on the trip, as ISO 3166-1 alpha-2 codes (KE, TZ) or English names (Kenya, Tanzania, Zanzibar). (1–10 items) |
| `days` | integer | no | Trip length in days. Calendar plans are priced for exactly this many days; fixed packages must last at least this long. Omit to list the standard durations. (min 1, max 365) |
| `min_data_gb` | number | no | Minimum total data for the trip in GB (calculate_safari_data can estimate it). Unlimited plans always qualify. (min 0, max 1000) |
| `unlimited_only` | boolean | no | Only return unlimited-data plans. |
| `max_price` | number | no | Maximum total price, in the requested currency. |
| `currency` | string | no | ISO 4217 code for prices, e.g. USD, EUR, GBP, KES. Defaults to USD. An unsupported code returns the supported list. (pattern `^[A-Za-z]{3}$`) |
| `limit` | integer | no | Maximum number of plans to return. Defaults to 10. (min 1, max 25) |

### Output

Top-level fields: `countries`, `days`, `currency`, `filters`, `total_matches`, `plans`, `note`. The full JSON Schema is in `tools/list` → `outputSchema`.

### Example

```json
{
  "countries": ["Kenya", "Tanzania"],
  "days": 10,
  "currency": "USD",
  "limit": 2
}
```

```json
{
  "countries": [
    {
      "iso2": "KE",
      "name": "Kenya"
    },
    {
      "iso2": "TZ",
      "name": "Tanzania"
    }
  ],
  "days": 10,
  "currency": "USD",
  "filters": {
    "min_data_gb": null,
    "unlimited_only": false,
    "max_price": null
  },
  "total_matches": 1,
  "plans": [
    {
      "name": "Africa Safari eSIM — 10 days",
      "destination": {
        "name": "Africa Safari",
        "slug": "africa-safari",
        "url": "https://safariesim.com/esim-africa-safari"
      },
      "coverage": {
        "type": "multi_country",
        "countries": ["KE", "TZ", "UG"]
      },
      "validity_days": 10,
      "data": {
        "unlimited": true,
        "total_gb": null,
        "high_speed_gb_per_day": 1,
        "speed_after_cap_kbps": 512,
        "summary": "Unlimited data: 1 GB/day at full speed, then 512 kbps"
      },
      "price": {
        "amount": 60,
        "currency": "USD",
        "per_day": 6
      },
      "networks": [
        {
          "country": "KE",
          "operator": "Safaricom",
          "network_types": ["4G"]
        },
        {
          "country": "TZ",
          "operator": "Vodacom",
          "network_types": ["4G"]
        }
      ],
      "hotspot_allowed": true,
      "top_up_available": false,
      "checkout_url": "https://safariesim.com/esim-africa-safari?days=10&checkout=1"
    }
  ]
}
```

### Edge cases

- Unknown or ambiguous country → `isError` result naming the input and, when ambiguous, the candidates.
- Valid country with no plans, no single plan covering every country, or filters that exclude everything → empty `plans` with a `note` saying which.
- Without `days`, plans are listed by duration (a ladder of the standard durations) instead of cheapest first.
- Unsupported `currency` → `isError` listing the currencies with an active rate.

## `compare_country_plans`

**Compare plans by country.** Compare eSIM options country by country for a trip: the cheapest plan and the cheapest unlimited plan in each country, the operators used there, and the cheapest single plans that cover every country (useful for multi-country safaris such as Kenya, Tanzania and Uganda). Use it for "compare Kenya and Tanzania" or when search_esim_plans finds no plan covering all countries. Prices are for the whole trip length.

### Input

| Field | Type | Required | Notes |
|---|---|---|---|
| `countries` | string[] | yes | Countries on the trip, as ISO 3166-1 alpha-2 codes (KE, TZ) or English names (Kenya, Tanzania, Zanzibar). (1–10 items) |
| `days` | integer | no | Trip length in days. Defaults to 7. (min 1, max 365) |
| `currency` | string | no | ISO 4217 code for prices, e.g. USD, EUR, GBP, KES. Defaults to USD. An unsupported code returns the supported list. (pattern `^[A-Za-z]{3}$`) |

### Output

Top-level fields: `days`, `days_defaulted`, `currency`, `countries`, `single_esim_for_all`, `note`. The full JSON Schema is in `tools/list` → `outputSchema`.

### Example

```json
{
  "countries": ["KE", "TZ"],
  "days": 10
}
```

```json
{
  "days": 10,
  "days_defaulted": false,
  "currency": "USD",
  "countries": [
    {
      "country": {
        "iso2": "KE",
        "name": "Kenya"
      },
      "plans_available": 2,
      "cheapest": {
        "name": "Kenya eSIM — 10 days",
        "destination": {
          "name": "Kenya",
          "slug": "kenya",
          "url": "https://safariesim.com/esim-kenya"
        },
        "coverage": {
          "type": "single_country",
          "countries": ["KE"]
        },
        "validity_days": 10,
        "data": {
          "unlimited": true,
          "total_gb": null,
          "high_speed_gb_per_day": 2,
          "speed_after_cap_kbps": 384,
          "summary": "Unlimited data: 2 GB/day at full speed, then 384 kbps"
        },
        "price": {
          "amount": 37,
          "currency": "USD",
          "per_day": 3.7
        },
        "networks": [
          {
            "country": "KE",
            "operator": "Airtel",
            "network_types": ["4G"]
          },
          {
            "country": "KE",
            "operator": "Safaricom",
            "network_types": ["5G", "4G"]
          }
        ],
        "hotspot_allowed": true,
        "top_up_available": true,
        "checkout_url": "https://safariesim.com/esim-kenya?days=10&checkout=1"
      },
      "cheapest_unlimited": {
        "name": "Kenya eSIM — 10 days",
        "destination": {
          "name": "Kenya",
          "slug": "kenya",
          "url": "https://safariesim.com/esim-kenya"
        },
        "coverage": {
          "type": "single_country",
          "countries": ["KE"]
        },
        "validity_days": 10,
        "data": {
          "unlimited": true,
          "total_gb": null,
          "high_speed_gb_per_day": 2,
          "speed_after_cap_kbps": 384,
          "summary": "Unlimited data: 2 GB/day at full speed, then 384 kbps"
        },
        "price": {
          "amount": 37,
          "currency": "USD",
          "per_day": 3.7
        },
        "networks": [
          {
            "country": "KE",
            "operator": "Airtel",
            "network_types": ["4G"]
          },
          {
            "country": "KE",
            "operator": "Safaricom",
            "network_types": ["5G", "4G"]
          }
        ],
        "hotspot_allowed": true,
        "top_up_available": true,
        "checkout_url": "https://safariesim.com/esim-kenya?days=10&checkout=1"
      },
      "networks": [
        {
          "operator": "Airtel",
          "network_types": ["4G"]
        },
        {
          "operator": "Safaricom",
          "network_types": ["5G", "4G"]
        }
      ]
    },
    {
      "country": {
        "iso2": "TZ",
        "name": "Tanzania"
      },
      "plans_available": 2,
      "cheapest": {
        "name": "Tanzania eSIM — 10 days",
        "destination": {
          "name": "Tanzania",
          "slug": "tanzania",
          "url": "https://safariesim.com/esim-tanzania"
        },
        "coverage": {
          "type": "single_country",
          "countries": ["TZ"]
        },
        "validity_days": 10,
        "data": {
          "unlimited": true,
          "total_gb": null,
          "high_speed_gb_per_day": 1.5,
          "speed_after_cap_kbps": 256,
          "summary": "Unlimited data: 1.5 GB/day at full speed, then 256 kbps"
        },
        "price": {
          "amount": 45,
          "currency": "USD",
          "per_day": 4.5
        },
        "networks": [
          {
            "country": "TZ",
            "operator": "Vodacom",
            "network_types": ["4G", "3G"]
          }
        ],
        "hotspot_allowed": false,
        "top_up_available": false,
        "checkout_url": "https://safariesim.com/esim-tanzania?days=10&checkout=1"
      },
      "cheapest_unlimited": {
        "name": "Tanzania eSIM — 10 days",
        "destination": {
          "name": "Tanzania",
          "slug": "tanzania",
          "url": "https://safariesim.com/esim-tanzania"
        },
        "coverage": {
          "type": "single_country",
          "countries": ["TZ"]
        },
        "validity_days": 10,
        "data": {
          "unlimited": true,
          "total_gb": null,
          "high_speed_gb_per_day": 1.5,
          "speed_after_cap_kbps": 256,
          "summary": "Unlimited data: 1.5 GB/day at full speed, then 256 kbps"
        },
        "price": {
          "amount": 45,
          "currency": "USD",
          "per_day": 4.5
        },
        "networks": [
          {
            "country": "TZ",
            "operator": "Vodacom",
            "network_types": ["4G", "3G"]
          }
        ],
        "hotspot_allowed": false,
        "top_up_available": false,
        "checkout_url": "https://safariesim.com/esim-tanzania?days=10&checkout=1"
      },
      "networks": [
        {
          "operator": "Vodacom",
          "network_types": ["4G", "3G"]
        }
      ]
    }
  ],
  "single_esim_for_all": [
    {
      "name": "Africa Safari eSIM — 10 days",
      "destination": {
        "name": "Africa Safari",
        "slug": "africa-safari",
        "url": "https://safariesim.com/esim-africa-safari"
      },
      "coverage": {
        "type": "multi_country",
        "countries": ["KE", "TZ", "UG"]
      },
      "validity_days": 10,
      "data": {
        "unlimited": true,
        "total_gb": null,
        "high_speed_gb_per_day": 1,
        "speed_after_cap_kbps": 512,
        "summary": "Unlimited data: 1 GB/day at full speed, then 512 kbps"
      },
      "price": {
        "amount": 60,
        "currency": "USD",
        "per_day": 6
      },
      "networks": [
        {
          "country": "KE",
          "operator": "Safaricom",
          "network_types": ["4G"]
        },
        {
          "country": "TZ",
          "operator": "Vodacom",
          "network_types": ["4G"]
        }
      ],
      "hotspot_allowed": true,
      "top_up_available": false,
      "checkout_url": "https://safariesim.com/esim-africa-safari?days=10&checkout=1"
    }
  ],
  "note": "single_esim_for_all lists the cheapest plans that cover every country for the whole trip. Prices are for all 10 days. If the trip is split between countries, compare price.per_day."
}
```

### Edge cases

- `days` defaults to 7 and `days_defaulted` says so.
- A country no plan covers comes back with `plans_available: 0` and null plans, plus a note.
- `single_esim_for_all` is null for a single country and an empty list when no plan covers every country.

## `get_country_networks`

**Get mobile networks for a country.** List the mobile operators and network types (5G, 4G, 3G) that Safari eSIM plans use in a country, and which plans use each operator. Use it for "which network does the Tanzania eSIM use?" or "is there 5G in Kenya?". It does not know signal strength at specific parks, lodges or roads.

### Input

| Field | Type | Required | Notes |
|---|---|---|---|
| `country` | string | yes | ISO 3166-1 alpha-2 code or English name, e.g. TZ or Tanzania. |

### Output

Top-level fields: `country`, `network_types`, `networks`, `note`. The full JSON Schema is in `tools/list` → `outputSchema`.

### Example

```json
{
  "country": "Kenya"
}
```

```json
{
  "country": {
    "iso2": "KE",
    "name": "Kenya"
  },
  "network_types": ["5G", "4G"],
  "networks": [
    {
      "operator": "Airtel",
      "network_types": ["4G"],
      "offered_on": [
        {
          "destination": "Kenya",
          "slug": "kenya",
          "coverage": "single_country",
          "url": "https://safariesim.com/esim-kenya"
        }
      ]
    },
    {
      "operator": "Safaricom",
      "network_types": ["5G", "4G"],
      "offered_on": [
        {
          "destination": "Africa Safari",
          "slug": "africa-safari",
          "coverage": "multi_country",
          "url": "https://safariesim.com/esim-africa-safari"
        },
        {
          "destination": "Kenya",
          "slug": "kenya",
          "coverage": "single_country",
          "url": "https://safariesim.com/esim-kenya"
        }
      ]
    }
  ],
  "note": "Operators come from the Safari eSIM catalog. Signal in remote areas such as national parks depends on each operator's local coverage, which this server does not track."
}
```

### Edge cases

- Operators recorded without a country are attributed to single-country plans only.
- A covered country with no recorded operators returns an empty `networks` list and says so in `note`.
- Never claims signal at a specific park or lodge.

## `calculate_safari_data`

**Estimate trip data needs.** Estimate how much mobile data a trip needs from its length and typical activities (messaging, maps, social media, photo uploads, video calls, streaming), including devices sharing a hotspot. Returns daily and total figures with the rates used, a recommendation between unlimited and fixed-data plans, and — when countries are given — the cheapest live plans that fit. Use it for "how much data do I need for a 10-day safari?".

### Input

| Field | Type | Required | Notes |
|---|---|---|---|
| `days` | integer | yes | Trip length in days. (min 1, max 365) |
| `profile` | "light" \| "moderate" \| "heavy" | no | light: messaging and maps. moderate (default): plus social media, photo uploads and short video calls. heavy: plus long video calls and streaming. |
| `daily_usage` | object | no | Per-day amounts that override the profile's defaults. Fields: `messaging_minutes`, `maps_minutes`, `web_minutes`, `social_media_minutes`, `video_call_minutes`, `streaming_minutes`, `photos_uploaded`. |
| `devices` | integer | no | Devices sharing the data through a hotspot. Defaults to 1. (min 1, max 10) |
| `countries` | string[] | no | If given, also returns the cheapest plans covering these countries that fit the estimate. (1–10 items) |
| `currency` | string | no | ISO 4217 code for prices, e.g. USD, EUR, GBP, KES. Defaults to USD. An unsupported code returns the supported list. (pattern `^[A-Za-z]{3}$`) |

### Output

Top-level fields: `days`, `devices`, `profile`, `daily_mb`, `total_gb`, `breakdown`, `recommendation`, `matching_plans`, `currency`, `assumptions`. The full JSON Schema is in `tools/list` → `outputSchema`.

### Example

```json
{
  "days": 10,
  "profile": "moderate",
  "countries": ["BW"]
}
```

```json
{
  "days": 10,
  "devices": 1,
  "profile": "moderate",
  "daily_mb": 312,
  "total_gb": 3.05,
  "breakdown": [
    {
      "activity": "Messaging (text and voice notes)",
      "amount_per_day": 90,
      "unit": "minute",
      "mb_per_day": 18
    },
    {
      "activity": "Maps and navigation",
      "amount_per_day": 30,
      "unit": "minute",
      "mb_per_day": 3
    },
    "… 4 more"
  ],
  "assumptions": "Typical app data rates (MB): messaging 0.2/min, maps 0.1/min, web 1/min, social media 2.5/min, video calls 6/min, streaming 12/min, 3 per uploaded photo, plus 10% background traffic, multiplied by the number of devices sharing the connection. Real usage varies with apps, video quality and network.",
  "recommendation": {
    "plan_type": "fixed_data",
    "reason": "Cheapest plan covering BW for 10 days that fits about 312 MB a day: Botswana 10 GB / 30 days at 44.99 USD."
  },
  "matching_plans": [
    {
      "name": "Botswana 10 GB / 30 days",
      "destination": {
        "name": "Botswana",
        "slug": "botswana",
        "url": "https://safariesim.com/esim-botswana"
      },
      "coverage": {
        "type": "single_country",
        "countries": ["BW"]
      },
      "validity_days": 30,
      "data": {
        "unlimited": false,
        "total_gb": 10,
        "high_speed_gb_per_day": null,
        "speed_after_cap_kbps": null,
        "summary": "10 GB total"
      },
      "price": {
        "amount": 44.99,
        "currency": "USD",
        "per_day": 1.5
      },
      "networks": [
        {
          "country": "BW",
          "operator": "Mascom",
          "network_types": ["4G"]
        }
      ],
      "hotspot_allowed": true,
      "top_up_available": false,
      "checkout_url": "https://safariesim.com/esim-botswana?variant=v-bw-10gb&checkout=1"
    }
  ],
  "currency": "USD"
}
```

### Edge cases

- `daily_usage` overrides individual profile values; set an activity to 0 to remove it.
- Rates are typical app figures and are returned in `assumptions`; the estimate is not a measurement.
- With `countries`, unlimited plans qualify when their daily full-speed allowance covers the daily estimate (or is unpublished); fixed plans need the total plus 20% headroom.

## `list_destinations`

**List destinations.** List the destinations Safari eSIM covers — African countries and multi-country plans by default — with their type (single or multi-country), the plan types offered and the product page. Use it for "which African countries do you cover?" or to find which plans include a country (query: "TZ").

### Input

| Field | Type | Required | Notes |
|---|---|---|---|
| `region` | "africa" \| "all" | no | africa (default): African countries and multi-country plans that are mostly African. all: every destination. |
| `query` | string | no | Filter by name, ISO code or covered country, e.g. "tanzania", "TZ", "safari". |

### Output

Top-level fields: `region`, `total`, `destinations`. The full JSON Schema is in `tools/list` → `outputSchema`.

### Example

```json
{
  "query": "TZ"
}
```

```json
{
  "region": "africa",
  "total": 2,
  "destinations": [
    {
      "name": "Tanzania",
      "slug": "tanzania",
      "type": "single_country",
      "country": {
        "iso2": "TZ",
        "name": "Tanzania"
      },
      "countries_covered": 1,
      "plan_types": ["unlimited"],
      "flag": "🇹🇿",
      "url": "https://safariesim.com/esim-tanzania"
    },
    {
      "name": "Africa Safari",
      "slug": "africa-safari",
      "type": "multi_country",
      "country": null,
      "countries_covered": 3,
      "plan_types": ["unlimited"],
      "flag": "🦁",
      "url": "https://safariesim.com/esim-africa-safari"
    }
  ]
}
```

### Edge cases

- `region: "africa"` keeps African countries and multi-country plans where at least half the countries are African.
- A `query` that resolves to a country lists every destination covering it; otherwise it matches names and slugs.

## Errors

- **Invalid arguments** (wrong type, out of range, empty list) → a tool result with `isError: true` and a message naming the field.
- **Business errors** (unknown country, unsupported currency) → `isError: true` with a message saying how to fix the call.
- **HTTP-level failures** return a JSON-RPC error body with `id: null`: `401` / `-32001` unknown or revoked partner key, `403` / `-32003` inactive affiliate key, `429` / `-32029` rate limited (see `Retry-After`), `413` request body over 64 KB, `400` / `-32700` malformed JSON.
