#!/usr/bin/env node
/** Compile only the runtime import graph, then replay with the documented process network APIs denied. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '../../..'), repo = path.resolve(web, '../..');
const require = createRequire(path.join(web, 'package.json'));
const ts = require('typescript');
const hash = (text) => createHash('sha256').update(text).digest('hex');
let output = path.join(repo, '_private/evals/sprint-contract-v1/latest');
let dataset = path.join(repo, 'evals/sprint-contract-v1/cases.json');
let customDataset = false;
const seenArgs = new Set();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (seenArgs.has(arg) || !['--dataset', '--output'].includes(arg) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) {
    process.stderr.write('usage: node apps/web/src/evals/sprint-contract-v1/run.mjs [--dataset path] [--output path]\n');
    process.exit(2);
  }
  seenArgs.add(arg);
  const value = path.resolve(repo, process.argv[++i]);
  if (arg === '--dataset') { dataset = value; customDataset = true; } else output = value;
}
mkdirSync(output, { recursive: true });
const build = mkdtempSync(path.join(output, '.build-'));
const reportPath = path.join(output, 'report.json'), guardLog = path.join(output, 'network-violations.jsonl');
let exitCode = 1;
try {
  const sourceRoot = path.join(web, 'src'), outRoot = path.join(build, 'src');
  symlinkSync(path.join(web, 'node_modules'), path.join(build, 'node_modules'), 'dir');
  writeFileSync(path.join(build, 'package.json'), '{"type":"module"}\n');
  const artifacts = new Map();
  function compile(source) {
    if (artifacts.has(source)) return;
    if (!source.startsWith(sourceRoot + path.sep) || !source.endsWith('.ts')) throw new Error('unexpected runtime import outside source graph');
    const text = readFileSync(source, 'utf8');
    const compiled = ts.transpileModule(text, { fileName: source, compilerOptions: {
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true, isolatedModules: true
    }, reportDiagnostics: true });
    const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => repo, getNewLine: () => '\n' }));
    const relative = path.relative(sourceRoot, source).replace(/\.ts$/, '.js');
    const emitted = path.join(outRoot, relative);
    mkdirSync(path.dirname(emitted), { recursive: true });
    writeFileSync(emitted, compiled.outputText);
    artifacts.set(source, { path: path.relative(repo, source), sourceSha256: hash(text), emittedSha256: hash(compiled.outputText) });
    const ast = ts.createSourceFile(emitted, compiled.outputText, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
    for (const statement of ast.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        if (specifier.startsWith('.')) compile(path.resolve(path.dirname(source), specifier.replace(/\.js$/, '.ts')));
        else if (!specifier.startsWith('node:') && !['parse5', 'mdast-util-from-markdown'].includes(specifier)) throw new Error(`unexpected runtime dependency ${specifier}`);
      }
    }
  }
  const defaultManifest = JSON.parse(readFileSync(path.join(repo, 'evals/sprint-contract-v1/manifest.json'), 'utf8'));
  const manifestKeys = ['suite', 'version', 'material', 'reviewStatus', 'track', 'networkAccess', 'license', 'caseCount', 'caseIds', 'datasetSha256', 'schemaSha256'];
  if (!defaultManifest || Array.isArray(defaultManifest) || Object.keys(defaultManifest).some((key) => !manifestKeys.includes(key)) || manifestKeys.some((key) => !Object.hasOwn(defaultManifest, key)) ||
    defaultManifest.suite !== 'sprint-contract-v1' || defaultManifest.version !== 1 || defaultManifest.material !== 'synthetic' || defaultManifest.reviewStatus !== 'unreviewed' || defaultManifest.track !== 'offline_deterministic_contract' || defaultManifest.networkAccess !== false || defaultManifest.license !== 'Apache-2.0' ||
    !Number.isSafeInteger(defaultManifest.caseCount) || defaultManifest.caseCount < 16 || !Array.isArray(defaultManifest.caseIds) || defaultManifest.caseIds.length !== defaultManifest.caseCount || new Set(defaultManifest.caseIds).size !== defaultManifest.caseCount || defaultManifest.caseIds.some((id) => typeof id !== 'string' || !/^SC-[0-9]{3}$/.test(id)) ||
    ![defaultManifest.datasetSha256, defaultManifest.schemaSha256].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw new Error('invalid frozen manifest');
  const datasetBytes = readFileSync(dataset, 'utf8');
  const schemaBytes = readFileSync(path.join(repo, 'evals/sprint-contract-v1/schema.json'), 'utf8');
  if (!customDataset && hash(datasetBytes) !== defaultManifest.datasetSha256) throw new Error('default dataset hash differs from frozen manifest');
  if (hash(schemaBytes) !== defaultManifest.schemaSha256) throw new Error('public schema hash differs from frozen manifest');
  compile(path.join(here, 'worker.ts'));
  writeFileSync(guardLog, '');
  const workerReport = path.join(build, 'worker-report.json');
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(here, 'network-guard.mjs')).href,
    path.join(outRoot, 'evals/sprint-contract-v1/worker.js'), dataset, workerReport], {
    cwd: repo, env: { PATH: process.env.PATH ?? '', STRIPSEARCH_SPRINT_GUARD_LOG: guardLog },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000
  });
  const report = existsSync(workerReport) ? JSON.parse(readFileSync(workerReport, 'utf8')) : {
    suite: 'sprint-contract-v1', status: 'worker_failed', cases: [], error: child.error?.message ?? child.stderr ?? 'worker did not produce evidence'
  };
  const violations = readFileSync(guardLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const sources = [...artifacts.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  report.provenance = { node: process.version, datasetSha256: hash(datasetBytes), schemaSha256: hash(schemaBytes),
    lockfileSha256: hash(readFileSync(path.join(web, 'package-lock.json'))), datasetOrigin: customDataset ? 'explicit_override' : 'frozen_manifest',
    runtimeGraph: sources, runtimeGraphSha256: hash(JSON.stringify(sources)),
    launcherSha256: hash(readFileSync(fileURLToPath(import.meta.url))), guardSha256: hash(readFileSync(path.join(here, 'network-guard.mjs'))) };
  report.worker = { exitCode: child.status, signal: child.signal, independentGuardViolations: violations };
  if (!customDataset && (report.total !== defaultManifest.caseCount || JSON.stringify(report.cases.map((c) => c.id)) !== JSON.stringify(defaultManifest.caseIds))) report.runFailure = 'executed cases differ from frozen manifest';
  const sanitize = (text) => text.replaceAll(build, '[build]').replaceAll(output, '[output]').replaceAll(repo, '[repository]');
  writeFileSync(reportPath, sanitize(JSON.stringify(report, null, 2)) + '\n');
  exitCode = report.status === 'invalid_dataset' ? 2 : child.status === 0 && !report.failed && !violations.length && !report.runFailure ? 0 : 1;
  process.stdout.write(JSON.stringify({ suite: report.suite, total: report.total ?? 0, passed: report.passed ?? 0, failed: report.failed ?? 0, status: report.status ?? (exitCode ? 'fail' : 'pass'), exitCode }) + '\n');
} catch (error) {
  writeFileSync(reportPath, JSON.stringify({ suite: 'sprint-contract-v1', status: 'runner_failed', cases: [], error: (error instanceof Error ? error.message : String(error)).replaceAll(repo, '[repository]').replaceAll(output, '[output]') }, null, 2) + '\n');
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
} finally {
  rmSync(build, { recursive: true, force: true });
}
process.exitCode = exitCode;
