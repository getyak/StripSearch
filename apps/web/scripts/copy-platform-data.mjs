#!/usr/bin/env node
/**
 * Copy the platform catalog data into the production build so the compiled
 * server reads its bundled `dist/data/platforms` copy from any working
 * directory (and the Docker runtime image gets the data via the existing
 * `dist` copy). No dependency changes; pure Node stdlib.
 *
 * Packaging safety (regression-tested in src/tests/platform-catalog.test.ts):
 *
 * - ONLY `data/platforms` is copied. The `data/` directory is also the default
 *   local SQLite / user-research store location; copying the whole directory
 *   would leak private application state into production images.
 * - Symlinks and other non-regular entries are REFUSED in the source subtree
 *   and in the generated public ancestors (dist / dist/data / bundle target)
 *   BEFORE any removal, copy or chmod — a link must never redirect writes or
 *   chmod outside the intended public bundle (lstat only; targets are never
 *   dereferenced or sanitized).
 * - The source subtree is validated first, so a refused run leaves sources,
 *   siblings and any previous artifact completely untouched.
 * - Only the generated public namespace (`dist`, `dist/data`, bundle dirs
 *   755 / files 644) is normalized to be world-readable for non-owner runtime
 *   users; sources, the project root and sibling data keep their modes.
 *
 * Usage: `node scripts/copy-platform-data.mjs` (run by `npm run build:data`).
 */

import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(packageRoot, 'data', 'platforms');
const distRoot = path.join(packageRoot, 'dist');
const distData = path.join(distRoot, 'data');
const distTarget = path.join(distData, 'platforms');

function refuse(message) {
  console.error(`copy-platform-data: ${message}`);
  process.exit(1);
}

/** lstat-based: symlinks and non-regular entries are refused, never followed. */
function assertRealDirectory(target, label) {
  let info;
  try {
    info = lstatSync(target);
  } catch {
    return; // absent is fine; it will be created inside the package
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    refuse(`${label} must be a real directory (symlinks refused): ${target}`);
  }
}

function assertCleanSourceTree(dir, label) {
  let rootInfo;
  try {
    rootInfo = lstatSync(dir);
  } catch {
    return refuse(`${label} is missing: ${dir}`);
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return refuse(`${label} root must be a real directory (symlinks refused): ${dir}`);
  }
  for (const name of readdirSync(dir)) {
    const target = path.join(dir, name);
    const info = lstatSync(target);
    if (info.isDirectory()) assertCleanSourceTree(target, label);
    else if (!info.isFile()) refuse(`${label} contains a non-regular entry (symlinks refused): ${target}`);
  }
}

// 1. Validate the SOURCE subtree first: no writes happen before this passes.
assertRealDirectory(path.join(packageRoot, 'data'), 'source data ancestor');
assertCleanSourceTree(sourceDir, 'source data');
for (const name of ['catalog.json', 'manifest.json']) {
  const required = path.join(sourceDir, name);
  if (!existsSync(required) || !lstatSync(required).isFile()) {
    refuse(`required public catalog file is missing: ${name}`);
  }
}

// 2. Validate the generated public namespace: root/ancestors/target must be
//    real directories so removal, copy and chmod cannot escape the package.
assertRealDirectory(distRoot, 'generated dist root');
assertRealDirectory(distData, 'generated dist/data');
assertRealDirectory(distTarget, 'generated bundle target');
for (const [target, label] of [[distRoot, 'dist root'], [distData, 'dist/data'], [distTarget, 'bundle target']]) {
  const resolved = path.resolve(target);
  if (resolved !== packageRoot && !resolved.startsWith(packageRoot + path.sep)) {
    refuse(`${label} escapes the package: ${target}`);
  }
}

// 3. Only now touch the artifact.
rmSync(distTarget, { recursive: true, force: true });
mkdirSync(distData, { recursive: true });
cpSync(sourceDir, distTarget, { recursive: true });

/**
 * Normalize ONLY the generated public namespace to 755/644 so a non-owner
 * runtime user (Docker `USER node` against root-owned files) can traverse and
 * read it. Sources and siblings are never chmod'd.
 */
function normalizePublicBundle(dir) {
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const target = path.join(dir, name);
    if (statSync(target).isDirectory()) normalizePublicBundle(target);
    else chmodSync(target, 0o644);
  }
}
chmodSync(distRoot, 0o755);
chmodSync(distData, 0o755);
normalizePublicBundle(distTarget);

console.log(`copy-platform-data: ${sourceDir} -> ${distTarget} (modes 755/644)`);
