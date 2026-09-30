#!/usr/bin/env node
/**
 * Copy the platform catalog data into the production build so the compiled
 * server reads its bundled `dist/data/platforms` copy from any working
 * directory (and the Docker runtime image gets the data via the existing
 * `dist` copy). No dependency changes; pure Node stdlib.
 *
 * Packaging safety: ONLY `data/platforms` is copied. The `data/` directory is
 * also the default local SQLite / user-research store location; copying the
 * whole directory would leak private application state into production
 * images. Never widen this source path.
 *
 * Usage: `node scripts/copy-platform-data.mjs` (run by `npm run build:data`).
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(packageRoot, 'data', 'platforms');
const distTarget = path.join(packageRoot, 'dist', 'data', 'platforms');

if (!existsSync(path.join(sourceDir, 'manifest.json'))) {
  console.error('copy-platform-data: data/platforms/manifest.json is missing; generate the catalog first.');
  process.exit(1);
}

rmSync(distTarget, { recursive: true, force: true });
mkdirSync(path.dirname(distTarget), { recursive: true });
cpSync(sourceDir, distTarget, { recursive: true });
console.log(`copy-platform-data: ${sourceDir} -> ${distTarget}`);
