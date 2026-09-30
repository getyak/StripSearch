# Dataset licensing (separate from the code license)

The repository code and original documents are Apache-2.0 (see /LICENSE).

The compiled public-rule data under `data/platforms/public-rules/` is a
derived dataset with per-source upstream terms:

- `maigret-*`: derived from soxoj/maigret (MIT, Copyright (c) 2020-2026
  Soxoj). MIT attribution and permission notice: `maigret-LICENSE.txt`,
  provenance and modifications: `maigret-NOTICE.md`.
- `whatsmyname-*`: derived from WebBreacher/WhatsMyName (CC BY-SA 4.0,
  Copyright (C) 2015-2026 Micah Hoffman). The upstream notice links the full
  CC BY-SA 4.0 terms (retained verbatim in `whatsmyname-LICENSE.txt` with its
  license URL); provenance and modifications: `whatsmyname-NOTICE.md`.

Share-alike applies to these derived dataset files only and does not change the
license of unrelated code in this repository. Raw upstream datasets are not
redistributed here; only normalized rules, exclusion receipts (row id/hash/
reason), attribution and license notices are committed.
