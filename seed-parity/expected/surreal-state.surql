-- Expected SurrealDB state after `seed apply --all` from an empty DB.
-- Spec §21: byte-equivalent to the canonical post-apply dump.
-- (Records are written via UPSERT countries:US CONTENT {...}.)

-- countries
INSERT INTO countries [
  { id: countries:US, iso: "US", name: "United States" },
  { id: countries:GB, iso: "GB", name: "United Kingdom" },
  { id: countries:JP, iso: "JP", name: "Japan" }
];

-- __seeds tracking
INSERT INTO __seeds [
  {
    id: __seeds:`baseline-countries`,
    name: "baseline-countries",
    applied_at: <datetime>"2026-05-04T00:00:00Z",
    key_hash: "sha256:<from-runner>",
    scope: ["development"],
    paths_touched: ["countries:GB", "countries:JP", "countries:US"],
    spec_version: "0.4.0",
    tracking_schema_version: "1"
  }
];
