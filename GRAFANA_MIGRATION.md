<!-- SPDX-License-Identifier: Apache-2.0 -->
# Grafana Dashboard Migration: Measurement Deltas

One-time migration guide for switching Grafana panels from cumulative
`v_measurements` queries to delta-based `v_measurement_deltas` queries.

## Why migrate?

The `v_measurements` view stores cumulative totals per session. For
multi-day sessions, the entire cost is attributed to the *last* idle
event's date — not spread across the days the session was actually
active. The `v_measurement_deltas` view records incremental changes,
so `SUM(delta)` over a date range gives the exact cost incurred during
that period.

## Panel migration table

| Panel | Current Source | New Source | Why |
|-------|---------------|------------|-----|
| Daily Cost (timeseries) | `v_measurements` | `v_measurement_deltas` | Accurate daily attribution |
| Today's Cost (stat) | `v_measurements` | `v_measurement_deltas` | Accurate "active today" |
| Weekly Cost Trend | `v_measurements` | `v_measurement_deltas` | Accurate weekly attribution |
| 7-Day Rolling Avg | `v_measurements` | `v_measurement_deltas` | Accurate rolling window |
| Cost by Classification | `v_measurements` | `v_measurements` (keep) | Cumulative totals are correct |
| Cost by Project | `v_measurements` | `v_measurements` (keep) | Cumulative totals are correct |
| Cost by Model | `v_measurements` | `v_measurements` (keep) | Cumulative totals are correct |

## Replacement queries

### Daily Cost (timeseries)

**Before:**

```sql
SELECT date(recorded_at_epoch, 'unixepoch', 'localtime') AS day,
       ROUND(SUM(value), 2) AS cost_usd
FROM v_measurements
WHERE metric_name = 'cost'
GROUP BY day
ORDER BY day DESC
LIMIT 14;
```

**After:**

```sql
SELECT date(recorded_at_epoch, 'unixepoch', 'localtime') AS day,
       ROUND(SUM(delta), 2) AS cost_usd
FROM v_measurement_deltas
WHERE metric_name = 'cost'
GROUP BY day
ORDER BY day DESC
LIMIT 14;
```

### Today's Cost (stat)

**Before:**

```sql
SELECT ROUND(SUM(value), 2) AS "Today's Cost"
FROM v_measurements
WHERE metric_name = 'cost'
  AND date(recorded_at_epoch, 'unixepoch') = date('now');
```

**After:**

```sql
SELECT ROUND(SUM(delta), 2) AS "Today's Cost"
FROM v_measurement_deltas
WHERE metric_name = 'cost'
  AND date(recorded_at_epoch, 'unixepoch') = date('now');
```

### Weekly Cost Trend

**Before:**

```sql
SELECT strftime('%Y-W%W',
         datetime(recorded_at_epoch, 'unixepoch')) AS week,
       ROUND(SUM(value), 2) AS cost_usd
FROM v_measurements
WHERE metric_name = 'cost'
GROUP BY week
ORDER BY week;
```

**After:**

```sql
SELECT strftime('%Y-W%W',
         datetime(recorded_at_epoch, 'unixepoch')) AS week,
       ROUND(SUM(delta), 2) AS cost_usd
FROM v_measurement_deltas
WHERE metric_name = 'cost'
GROUP BY week
ORDER BY week;
```

### 7-Day Rolling Average

**Before:**

```sql
SELECT day,
       ROUND(AVG(daily_cost) OVER (
         ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ), 2) AS rolling_avg
FROM (
  SELECT date(recorded_at_epoch, 'unixepoch') AS day,
         SUM(value) AS daily_cost
  FROM v_measurements
  WHERE metric_name = 'cost'
  GROUP BY day
)
ORDER BY day;
```

**After:**

```sql
SELECT day,
       ROUND(AVG(daily_cost) OVER (
         ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ), 2) AS rolling_avg
FROM (
  SELECT date(recorded_at_epoch, 'unixepoch') AS day,
         SUM(delta) AS daily_cost
  FROM v_measurement_deltas
  WHERE metric_name = 'cost'
  GROUP BY day
)
ORDER BY day;
```

## Panels to keep unchanged

The following panels use cumulative totals which are already correct —
no migration needed:

- **Cost by Classification** — groups by session classification,
  `SUM(value)` per classification is the true total.
- **Cost by Project** — groups by project, `SUM(value)` per project
  is the true total.
- **Cost by Model** — groups by model, `SUM(value)` per model is the
  true total.

## Backfill existing data

After deploying the schema change, run the backfill to populate
`measurement_deltas` for historical sessions:

```sh
make backfill
```

Each historical session produces one delta row per non-zero metric
(delta equals the cumulative value since there is only one data point
per backfilled session).
