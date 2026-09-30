#!/usr/bin/env node
/**
 * GET-91 maintenance import: compile pinned public rule source bytes into the
 * normalized public-rule bundle under `data/platforms/public-rules/`.
 *
 * EXPLICIT LOCAL INPUTS ONLY. This CLI never downloads anything: the parent
 * maintenance task retrieves pinned upstream bytes (Maigret MIT, WhatsMyName
 * CC BY-SA 4.0) into a local cache and passes their paths here. Offline tests
 * and production startup never run this script and never fetch upstream data.
 *
 * Output is deterministic for fixed inputs: rules/exclusions are sorted, the
 * generation time comes from the pinned manifests, and every generated file is
 * pinned by byte hash in `manifest.json`.
 *
 * Usage:
 *   node --import tsx scripts/import-public-rules.ts \
 *     --maigret-data <file> --maigret-license <file> --maigret-manifest <file> \
 *     --wmn-data <file> --wmn-license <file> --wmn-manifest <file> \
 *     --catalog data/platforms/catalog.json \
 *     --out data/platforms/public-rules
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUBLIC_RULE_IMPORTER_VERSION,
  PUBLIC_RULES_MANIFEST_SCHEMA_VERSION,
  PUBLIC_RULES_SCHEMA_VERSION
} from '../src/shared/public-discovery-rules.js';
import type { PublicRuleImport, PublicRuleSourceInput, PublicRuleSourceRecord } from '../src/shared/public-discovery-rules.js';
import type { CatalogEntry } from '../src/shared/platform-catalog.js';
import {
  buildSourceNotice,
  compilePublicRules,
  extractRequiredCopyright,
  knownPlatformTemplateMap,
  mergePublicRules
} from '../src/server/platforms/public-rules.js';

interface Args {
  [key: string]: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
}

function requireArg(args: Args, name: string): string {
  const value = args[name];
  if (value === undefined) throw new Error(`missing required argument --${name}`);
  return value;
}

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

interface PinnedManifest {
  repository: string;
  sourceUrl: string;
  commit: string;
  retrievedAt: string;
  sha256: string;
  bytes: number;
  licenseHash: string;
  siteRecords: number;
}

function readPinnedManifest(file: string): PinnedManifest {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  for (const key of ['repository', 'sourceUrl', 'commit', 'retrievedAt', 'sha256', 'licenseHash']) {
    if (typeof raw[key] !== 'string') throw new Error(`${file}: missing ${key}`);
  }
  if (typeof raw.bytes !== 'number' || typeof raw.siteRecords !== 'number') {
    throw new Error(`${file}: missing bytes/siteRecords`);
  }
  return raw as unknown as PinnedManifest;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const maigretData = requireArg(args, 'maigret-data');
  const maigretLicense = requireArg(args, 'maigret-license');
  const maigretManifest = requireArg(args, 'maigret-manifest');
  const wmnData = requireArg(args, 'wmn-data');
  const wmnLicense = requireArg(args, 'wmn-license');
  const wmnManifest = requireArg(args, 'wmn-manifest');
  const catalogFile = requireArg(args, 'catalog');
  const outDir = requireArg(args, 'out');

  const maigretBytes = readFileSync(maigretData);
  const wmnBytes = readFileSync(wmnData);
  const maigretLicenseText = readFileSync(maigretLicense, 'utf8');
  const wmnLicenseText = readFileSync(wmnLicense, 'utf8');
  const maigretPinned = readPinnedManifest(maigretManifest);
  const wmnPinned = readPinnedManifest(wmnManifest);

  // Fixed-version license check: the pinned manifest's license hash must match
  // the exact license text we attribute. A mismatch blocks the import.
  if (sha256Hex(maigretLicenseText) !== maigretPinned.licenseHash) {
    throw new Error('maigret LICENSE bytes do not match the pinned licenseHash');
  }
  if (sha256Hex(wmnLicenseText) !== wmnPinned.licenseHash) {
    throw new Error('whatsmyname LICENSE bytes do not match the pinned licenseHash');
  }

  const inputs: PublicRuleSourceInput[] = [
    {
      sourceId: 'maigret',
      kind: 'maigret_sites',
      bytes: maigretBytes,
      licenseText: maigretLicenseText,
      manifest: {
        repository: maigretPinned.repository,
        sourceUrl: maigretPinned.sourceUrl,
        commit: maigretPinned.commit,
        retrievedAt: maigretPinned.retrievedAt,
        license: 'MIT',
        licenseUrl: `https://github.com/soxoj/maigret/blob/${maigretPinned.commit}/LICENSE`,
        sha256: maigretPinned.sha256,
        bytes: maigretPinned.bytes,
        recordCount: maigretPinned.siteRecords
      }
    },
    {
      sourceId: 'whatsmyname',
      kind: 'whatsmyname_sites',
      bytes: wmnBytes,
      licenseText: wmnLicenseText,
      manifest: {
        repository: wmnPinned.repository,
        sourceUrl: wmnPinned.sourceUrl,
        commit: wmnPinned.commit,
        retrievedAt: wmnPinned.retrievedAt,
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        sha256: wmnPinned.sha256,
        bytes: wmnPinned.bytes,
        recordCount: wmnPinned.siteRecords
      }
    }
  ];

  const imports: PublicRuleImport[] = [];
  for (const input of inputs) {
    const imported = compilePublicRules(input);
    if (imported.verification.mismatch.length > 0) {
      throw new Error(
        `${input.sourceId}: pinned byte/count verification failed: ${imported.verification.mismatch.join(',')}`
      );
    }
    imports.push(imported);
  }

  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8')) as { entries: CatalogEntry[] };
  const knownTemplates = knownPlatformTemplateMap(catalog.entries);
  const union = mergePublicRules(imports, { knownTemplates });

  // Deterministic generation time: the latest pinned retrieval timestamp.
  const generatedAt = inputs
    .map((input) => input.manifest.retrievedAt)
    .sort()
    .at(-1) as string;

  if (existsSync(outDir)) {
    const info = lstatSync(outDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`--out must be a real directory: ${outDir}`);
    for (const name of readdirSync(outDir)) unlinkSync(path.join(outDir, name));
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  const rulesDoc = {
    schemaVersion: PUBLIC_RULES_SCHEMA_VERSION,
    importerVersion: PUBLIC_RULE_IMPORTER_VERSION,
    generatedAt,
    rules: union.rules
  };
  const exclusionsDoc = {
    schemaVersion: PUBLIC_RULES_SCHEMA_VERSION,
    importerVersion: PUBLIC_RULE_IMPORTER_VERSION,
    generatedAt,
    sources: imports.map((imported) => ({ sourceId: imported.sourceId, exclusions: imported.exclusions }))
  };
  writeFileSync(path.join(outDir, 'rules.json'), `${JSON.stringify(rulesDoc, null, 1)}\n`);
  writeFileSync(path.join(outDir, 'exclusions.json'), `${JSON.stringify(exclusionsDoc, null, 1)}\n`);
  writeFileSync(path.join(outDir, 'maigret-LICENSE.txt'), maigretLicenseText);
  writeFileSync(path.join(outDir, 'whatsmyname-LICENSE.txt'), wmnLicenseText);
  writeFileSync(
    path.join(outDir, 'maigret-NOTICE.md'),
    buildSourceNotice({
      sourceId: 'maigret',
      source: imports[0]!.source,
      copyrightLine: extractRequiredCopyright(maigretLicenseText),
      licenseFile: 'maigret-LICENSE.txt'
    })
  );
  writeFileSync(
    path.join(outDir, 'whatsmyname-NOTICE.md'),
    buildSourceNotice({
      sourceId: 'whatsmyname',
      source: imports[1]!.source,
      copyrightLine: extractRequiredCopyright(wmnLicenseText),
      licenseFile: 'whatsmyname-LICENSE.txt'
    })
  );
  writeFileSync(path.join(outDir, 'LICENSE-DATASETS.md'), datasetLicenseNotice());

  const generatedFiles = [
    'rules.json',
    'exclusions.json',
    'maigret-LICENSE.txt',
    'whatsmyname-LICENSE.txt',
    'maigret-NOTICE.md',
    'whatsmyname-NOTICE.md',
    'LICENSE-DATASETS.md'
  ];
  const manifest = {
    schemaVersion: PUBLIC_RULES_MANIFEST_SCHEMA_VERSION,
    importerVersion: PUBLIC_RULE_IMPORTER_VERSION,
    generatedAt,
    files: generatedFiles.map((name) => {
      const bytes = readFileSync(path.join(outDir, name));
      return { path: name, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
    }),
    sources: imports.map((imported) => ({
      ...(imported.source as PublicRuleSourceRecord),
      notice: imported.sourceId === 'maigret' ? 'maigret-NOTICE.md' : 'whatsmyname-NOTICE.md',
      licenseFile: imported.sourceId === 'maigret' ? 'maigret-LICENSE.txt' : 'whatsmyname-LICENSE.txt'
    })),
    counts: {
      sourceRows: union.counts.sourceRows,
      loaded: union.counts.loaded,
      excluded: union.counts.excluded
    },
    union: {
      platforms: union.counts.unionPlatforms,
      instances: union.counts.unionInstances,
      routes: union.counts.unionRoutes,
      generatedPlatforms: union.counts.generatedPlatforms,
      knownMappedGroups: union.counts.knownMappedGroups,
      knownTemplates: knownTemplates.size
    }
  };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);

  // Audit receipt (stdout): full pinned byte hash / count reconciliation.
  const audit = {
    importerVersion: PUBLIC_RULE_IMPORTER_VERSION,
    generatedAt,
    sources: imports.map((imported) => ({
      sourceId: imported.sourceId,
      contentHash: imported.source.contentHash,
      bytes: imported.source.bytes,
      license: imported.source.license,
      licenseHash: imported.source.licenseHash,
      counts: imported.source.counts,
      rawReconciles: imported.source.counts.raw === imported.source.counts.loaded + imported.source.counts.excluded,
      exclusionsByReason: imported.source.exclusionsByReason
    })),
    union: union.counts
  };
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}

function datasetLicenseNotice(): string {
  return `# Dataset licensing (separate from the code license)

The repository code and original documents are Apache-2.0 (see /LICENSE).

The compiled public-rule data under \`data/platforms/public-rules/\` is a
derived dataset with per-source upstream terms:

- \`maigret-*\`: derived from soxoj/maigret (MIT, Copyright (c) 2020-2026
  Soxoj). MIT attribution and permission notice: \`maigret-LICENSE.txt\`,
  provenance and modifications: \`maigret-NOTICE.md\`.
- \`whatsmyname-*\`: derived from WebBreacher/WhatsMyName (CC BY-SA 4.0,
  Copyright (C) 2015-2026 Micah Hoffman). The upstream notice links the full
  CC BY-SA 4.0 terms (retained verbatim in \`whatsmyname-LICENSE.txt\` with its
  license URL); provenance and modifications: \`whatsmyname-NOTICE.md\`.

Share-alike applies to these derived dataset files only and does not change the
license of unrelated code in this repository. Raw upstream datasets are not
redistributed here; only normalized rules, exclusion receipts (row id/hash/
reason), attribution and license notices are committed.
`;
}

try {
  main();
} catch (error) {
  console.error(`import-public-rules: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
