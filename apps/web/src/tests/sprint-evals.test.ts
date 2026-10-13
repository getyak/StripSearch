import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET_SCHEMA, DatasetError, parseDataset, type ContractCase } from '../evals/sprint-contract-v1/schema.js';
import { executeCase } from '../evals/sprint-contract-v1/case-runner.js';
import { gradeCase, replay } from '../evals/sprint-contract-v1/grade.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = path.join(repo, 'evals/sprint-contract-v1');
const harness = path.join(repo, 'apps/web/src/evals/sprint-contract-v1');
const raw = () => JSON.parse(readFileSync(path.join(suite, 'cases.json'), 'utf8'));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function temporary<T>(run: (directory: string) => T): T {
  const base = path.join(repo, '_private/evals/sprint-contract-v1/tests');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'case-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function cli(args: string[], cwd = repo) {
  return spawnSync(process.execPath, [path.join(harness, 'run.mjs'), ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
}

test('sprint eval public schema and frozen manifest match the strict runtime contract', () => {
  assert.deepEqual(JSON.parse(readFileSync(path.join(suite, 'schema.json'), 'utf8')), DATASET_SCHEMA);
  const dataset = parseDataset(raw());
  const manifest = JSON.parse(readFileSync(path.join(suite, 'manifest.json'), 'utf8'));
  assert.equal(dataset.cases.length, 33);
  assert.equal(manifest.caseCount, dataset.cases.length);
  assert.deepEqual(manifest.caseIds, dataset.cases.map((entry) => entry.id));
  assert.equal(manifest.datasetSha256, hash(readFileSync(path.join(suite, 'cases.json'), 'utf8')));
  assert.equal(manifest.schemaSha256, hash(readFileSync(path.join(suite, 'schema.json'), 'utf8')));
});

const invalidMutations: [string, (dataset: ReturnType<typeof raw>) => void][] = [
  ['unknown case kind', (d) => { d.cases[0].kind = 'pretend_pass'; }],
  ['unknown expectation', (d) => { d.cases[0].expected.pretend = true; }],
  ['missing expectation', (d) => { delete d.cases[0].expected.state; }],
  ['unknown state', (d) => { d.cases[0].expected.state = 'excellent'; }],
  ['wrong boolean type', (d) => { d.cases[0].expected.suggested = 'true'; }],
  ['malformed source', (d) => { d.cases[0].input.documents[0].original = null; }],
  ['invalid URL', (d) => { d.cases[0].input.documents[0].sourceUrl = 'garbage'; }],
  ['unknown input key', (d) => { d.cases[0].input.documents[0].fabricated = true; }],
  ['prototype named input key', (d) => { d.cases[0].input.constructor = 'spoof'; }],
  ['duplicate case', (d) => { d.cases[1].id = d.cases[0].id; }],
  ['duplicate boundary', (d) => { d.cases[1].boundary = d.cases[0].boundary; }],
  ['duplicate semantic input', (d) => { d.cases[1].input = structuredClone(d.cases[0].input); }],
  ['inconsistent count', (d) => { d.cases[0].expected.supportCount = 99; }],
  ['negative count', (d) => { d.cases[0].expected.candidateCount = -1; }],
  ['unsafe integer', (d) => { d.cases[0].expected.supportCount = Number.MAX_SAFE_INTEGER + 1; }],
  ['false raw fidelity expectation', (d) => { d.cases[0].expected.rawSpanExact = false; }],
  ['non JSON number', (d) => { d.cases[20].input.args.unsupported = Infinity; }],
  ['non JSON executable', (d) => { d.cases[20].input.args.unsupported = () => 1; }],
  ['unknown tool', (d) => { d.cases[20].input.tool = 'internet_everywhere'; }],
  ['null tool input', (d) => { d.cases[20].input.args = null; }],
  ['missing refusal reason', (d) => { d.cases[20].expected.reasonIncludes = null; }],
  ['mismatched owner expectation', (d) => { d.cases[13].expected.offset = null; }],
  ['network enabled', (d) => { d.networkAccess = true; }],
  ['fake review label', (d) => { d.reviewStatus = 'human_gold'; }],
  ['insufficient case count', (d) => { d.cases = d.cases.slice(0, 1); }]
];
for (const [name, mutate] of invalidMutations) test(`sprint eval rejects ${name}`, () => {
  const dataset = raw(); mutate(dataset); assert.throws(() => parseDataset(dataset), DatasetError);
});

test('sprint eval actually executes production functions and preserves deterministic evidence', async () => {
  const dataset = parseDataset(raw());
  const first = await replay(dataset);
  assert.equal(first.total, 33); assert.equal(first.failed, 0, JSON.stringify(first.cases.filter((c) => c.status === 'fail')));
  assert.deepEqual(await replay(dataset), first);
  assert.equal(first.cases[0]?.actual?.rawSpanExact, true);
  assert.match(JSON.stringify(first.cases[0]?.evidence), /&#45;/, 'raw entity spelling must survive');
  assert.equal(first.qualityClaim, false);
});

test('sprint grader catches wrong actual results without comparing expectations to themselves', async () => {
  const dataset = parseDataset(raw());
  const entry = dataset.cases[0]!;
  const actual = await executeCase(entry);
  actual.observed.suggested = false;
  actual.observed.rawSpanExact = false;
  const graded = gradeCase(entry, actual);
  assert.equal(graded.status, 'fail');
  assert.deepEqual(graded.failures.map((f) => f.path), ['suggested', 'rawSpanExact']);
});

test('sprint replay preserves a crashed case and executes every later case', async () => {
  const dataset = parseDataset(raw());
  let count = 0;
  const result = await replay(dataset, async (entry) => {
    count++; if (count === 1) throw new Error('synthetic execution failure');
    return executeCase(entry);
  });
  assert.equal(count, 33); assert.equal(result.failed, 1); assert.equal(result.passed, 32);
  assert.equal(result.cases[0]?.failures[0]?.message, 'synthetic execution failure');
  assert.equal(result.cases.at(-1)?.status, 'pass');
});

test('unknown kind cannot silently skip the executor even without parsing', async () => {
  await assert.rejects(executeCase({ kind: 'unknown' } as unknown as ContractCase), /unknown case kind/);
});

test('guarded CLI works from apps/web and emits a deterministic complete replay', () => temporary((directory) => {
  const relative = path.relative(repo, directory);
  const first = cli(['--output', relative], path.join(repo, 'apps/web'));
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const bytes = readFileSync(path.join(directory, 'report.json'), 'utf8');
  const report = JSON.parse(bytes);
  assert.equal(report.total, 33); assert.equal(report.failed, 0);
  assert.equal(report.provenance.datasetOrigin, 'frozen_manifest');
  assert.ok(report.provenance.runtimeGraph.some((entry: {path: string}) => entry.path.endsWith('research-tool-dispatch.ts')));
  assert.deepEqual(report.worker.independentGuardViolations, []);
  assert.equal(readFileSync(path.join(directory, 'network-violations.jsonl'), 'utf8'), '');
  const second = cli(['--output', relative]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(path.join(directory, 'report.json'), 'utf8'), bytes);
}));

test('CLI returns 1 for an independently wrong expectation and retains all 33 case records', () => temporary((directory) => {
  const dataset = raw(); dataset.cases[0].expected.suggested = false;
  const file = path.join(directory, 'bad-expectation.json'); writeFileSync(file, JSON.stringify(dataset));
  const result = cli(['--dataset', file, '--output', path.join(directory, 'result')]);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const report = JSON.parse(readFileSync(path.join(directory, 'result/report.json'), 'utf8'));
  assert.equal(report.total, 33); assert.equal(report.failed, 1); assert.equal(report.passed, 32);
  assert.equal(report.cases[0].failures[0].path, 'suggested');
  assert.equal(report.cases.at(-1).status, 'pass');
}));

test('CLI returns 2 for invalid input without inventing successful case records', () => temporary((directory) => {
  const dataset = raw(); dataset.cases[0].kind = 'made_up';
  const file = path.join(directory, 'invalid.json'); writeFileSync(file, JSON.stringify(dataset));
  const result = cli(['--dataset', file, '--output', path.join(directory, 'result')]);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  const report = JSON.parse(readFileSync(path.join(directory, 'result/report.json'), 'utf8'));
  assert.equal(report.status, 'invalid_dataset'); assert.deepEqual(report.cases, []);
}));

test('CLI refuses unknown or incomplete arguments', () => {
  for (const args of [['--pretend-success'], ['--output'], ['--dataset', '--output'], ['--output', 'a', '--output', 'b']]) assert.equal(cli(args).status, 2);
});

const probes: [string, string][] = [
  ['fetch', 'try { await fetch("https://guard-only.invalid/"); } catch {}'],
  ['http.get', 'const {get} = await import("node:http"); try { get("http://guard-only.invalid/"); } catch {}'],
  ['https.request', 'const {request} = await import("node:https"); try { request("https://guard-only.invalid/"); } catch {}'],
  ['http2.connect', 'const {connect} = await import("node:http2"); try { connect("https://guard-only.invalid/"); } catch {}'],
  ['dns/promises.lookup', 'const {lookup} = await import("node:dns/promises"); try { await lookup("guard-only.invalid"); } catch {}'],
  ['dns/promises.resolve', 'const {promises} = await import("node:dns"); try { await promises.resolve("guard-only.invalid"); } catch {}'],
  ['dns/promises.Resolver.resolve4', 'const {Resolver} = await import("node:dns/promises"); try { await new Resolver().resolve4("guard-only.invalid"); } catch {}'],
  ['net.connect', 'const {connect} = await import("node:net"); try { connect(443, "guard-only.invalid"); } catch {}'],
  ['tls.connect', 'const {connect} = await import("node:tls"); try { connect(443, "guard-only.invalid"); } catch {}'],
  ['child_process.spawnSync', 'const {spawnSync} = await import("node:child_process"); try { spawnSync(process.execPath, ["-e", "process.exit(0)"]); } catch {}'],
  ['worker_threads.Worker', 'const {Worker} = await import("node:worker_threads"); try { new Worker("process.exit(0)", {eval:true}); } catch {}'],
  ['dgram.createSocket', 'const {createSocket} = await import("node:dgram"); try { createSocket("udp4"); } catch {}']
];
for (const [api, code] of probes) test(`network guard durably records and fails swallowed ${api}`, () => temporary((directory) => {
  const log = path.join(directory, 'violations.jsonl');
  const child = spawnSync(process.execPath, ['--import', path.join(harness, 'network-guard.mjs'), '--input-type=module', '-e', code + ';process.exitCode=0;'], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, STRIPSEARCH_SPRINT_GUARD_LOG: log }
  });
  assert.equal(child.status, 1, child.stderr);
  const violations = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(violations.map((entry) => entry.api), [api]);
}));
