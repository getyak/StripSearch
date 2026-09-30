# whatsmyname derived dataset notice

- Upstream project: https://github.com/WebBreacher/WhatsMyName
- Pinned source: https://raw.githubusercontent.com/WebBreacher/WhatsMyName/062bcfe48df79fa618e96edc79dc9673f3fe5643/wmn-data.json
- Pinned commit: 062bcfe48df79fa618e96edc79dc9673f3fe5643
- Retrieved (pinned manifest): 2026-09-30T05:31:03.956135+00:00
- Source bytes: 259104 bytes, sha256 `507d2f8aa5b1297ae2d713634ccc7ce08357fed85b1d40130585810f456c1cfe`
- Importer: get91-public-rule-importer/1
- Rows: raw 717 = loaded 651 + excluded 66

Copyright: Copyright (C) 2015-2026 Micah Hoffman

License: CC BY-SA 4.0 - https://creativecommons.org/licenses/by-sa/4.0/
The exact license text captured at the pinned commit is in `whatsmyname-LICENSE.txt`.

Modifications: this directory contains a DERIVED DATASET, not the upstream
dataset. The importer normalized request/profile templates, kept only bounded
detection predicates (literal markers and documented status codes), replaced
source row ids with row hashes for exclusions, dropped raw username examples,
descriptions, third-party full text and all header/token values, and excluded
inadmissible rows with explicit per-row reasons (`exclusions.json`). No
upstream code is copied. Redistribution of these derived data files stays under
CC BY-SA 4.0 terms; see `LICENSE-DATASETS.md`.
