# maigret derived dataset notice

- Upstream project: https://github.com/soxoj/maigret
- Pinned source: https://raw.githubusercontent.com/soxoj/maigret/b6642744988e7e6c2d21f75db60ec3093019ba25/maigret/resources/data.json
- Pinned commit: b6642744988e7e6c2d21f75db60ec3093019ba25
- Retrieved (pinned manifest): 2026-09-30T05:30:59.298392+00:00
- Source bytes: 2496965 bytes, sha256 `3ac973e44f765c1c2b851571bd165f45145d0a00231c8ea97fb479e93f6aa289`
- Importer: get91-public-rule-importer/1
- Rows: raw 6206 = loaded 3952 + excluded 2254

Copyright: Copyright (c) 2020-2026 Soxoj

License: MIT - https://github.com/soxoj/maigret/blob/b6642744988e7e6c2d21f75db60ec3093019ba25/LICENSE
The exact license text captured at the pinned commit is in `maigret-LICENSE.txt`.

Modifications: this directory contains a DERIVED DATASET, not the upstream
dataset. The importer normalized request/profile templates, kept only bounded
detection predicates (literal markers and documented status codes), replaced
source row ids with row hashes for exclusions, dropped raw username examples,
descriptions, third-party full text and all header/token values, and excluded
inadmissible rows with explicit per-row reasons (`exclusions.json`). No
upstream code is copied. Redistribution of these derived data files stays under
MIT terms; see `LICENSE-DATASETS.md`.
