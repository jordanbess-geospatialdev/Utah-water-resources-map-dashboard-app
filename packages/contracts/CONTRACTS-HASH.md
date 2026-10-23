# Contract hashes — Utah Water Measurement Data Dashboard

Version: v0.1.1 — published 2026-10-21 — owner: contract_data (WD-027)

Revision v0.1.1 aligns assignment roles with the existing runtime, including public
and water-user. The v0.1.0 fixture seed remains compatible. No role label grants
capabilities or changes supplier-reviewer authority.

sha256 over the exact bytes of each contract file as committed (LF line endings,
per repository `.gitattributes`). Any change to a contract file requires a new
version label and a new hash table.

| File | sha256 |
| --- | --- |
| openapi.json | 3ec6279881b260d3ecb4524061b2b32391a8b0dc5d8131382843da3e0dfa7661 |
| schemas/async-job.json | e5954471b96e4f5ddfb027c72a4f522e1c62fd6bd8b0eb3d924084b889c4d030 |
| schemas/catalog-layer.json | 9b523a342269bf11fc0f54536574e0d43acf4b423794d56e64d909d37cda67d4 |
| schemas/entitlement.json | 44e6c9de936c05d0d4fcb1e8871fc45d984639db5e9d15f6595c44939ee76da8 |
| schemas/error.json | 837b2f41f72322711a2a226044ca62d50015e8ea0d7f75a7b26f1de1f3530a85 |
| schemas/filter-set.json | def006d833612de32735cef6164d77f0610a1bc4d4f85991ce112b6cf643c03d |
| schemas/observation.json | 75e8bb1d37ddaf4760ab4ec62aaf4fc88b3702489d344767603e557759f3b3eb |
| schemas/revision.json | 8246ec70e53a68487822fd296eb6e1ae8d62d04593d1cb9288872bfb2b2875da |
| schemas/site.json | 214b6aa7a8f80a913a5d3d56f2f345d50df5c1f65a79d2aa28dd24760f6cf85a |

`packages/contracts/check.mjs` recomputes every digest on each run and fails if
the published table disagrees with the files on disk.

Consumers must agree this hash before implementing against these contracts.
