/**
 * Report model for the research-baseline-v1 offline controller replay.
 *
 * Honest accounting rules baked into the report type:
 * - structural pass/fail is separate from the research state distribution;
 * - every scheduled case (started, unfinished or never started) stays in the
 *   pass-rate denominator;
 * - modelInvocations counts actual model gateway calls of this execution while
 *   modelReceipts preserves same-run ledger history separately; token/cost stay
 *   not_measured (never a fabricated zero);
 * - fixture-declared fees are labelled simulated: a known subtotal is only
 *   reported alongside an explicit unknown-fee count, and the complete
 *   simulatedTotal stays null whenever any fee is unknown;
 * - hashes come in two honest flavours: `serialized` subobject hashes and the
 *   `artifact` hash of the exact final bytes written to disk.
 */

import type { CaseCompletion, CaseCounts, CaseError, CaseFixtureUsage } from './case-runner.js';
import type { FixtureViolation } from './fixtures.js';
import { VOLATILE_NORMALIZATION } from './normalize.js';
import type { BaselineExpect, BaselineState } from './schema.js';

export interface BaselineHashes {
  normalizedResult: string;
  /** SHA256 of each raw subobject's stable JSON serialization (markdown as raw text). */
  serialized: {
    result: string | null;
    checkpoint: string | null;
    receipts: string | null;
    canonical: string | null;
    markdown: string | null;
  };
  /** SHA256 of the exact final sanitized artifact bytes written to disk. */
  artifact: string | null;
}

export interface BaselineCaseActual {
  state: BaselineState;
  stopReason: string | null;
  identityStatus: string | null;
  completion: CaseCompletion;
  counts: CaseCounts;
  receipts: { total: number; completed: number; failed: number; inflight: number };
  unknownCost: boolean;
  claimsRetained: number | null;
  candidates: number | null;
  runnerError: string | null;
  fixtureViolations: FixtureViolation[];
  executionError: CaseError | null;
  fixtureUsage: CaseFixtureUsage;
  effectiveLimits: Record<string, number>;
}

export interface BaselineCaseReport {
  caseId: string;
  scenario: string;
  title: string;
  tags: string[];
  expected: BaselineExpect;
  actual: BaselineCaseActual;
  structural: 'pass' | 'fail';
  failures: string[];
  hardFailure: boolean;
  monotonicElapsedMs: number;
  hashes: BaselineHashes;
  artifact: string;
}

export interface BaselineSummary {
  /** All cases declared by the dataset; the only pass-rate denominator. */
  scheduled: number;
  caseProgress: { started: number; finished: number; unfinished: number; notRun: number };
  structural: { passed: number; failed: number };
  passRate: { value: number | null; denominator: number };
  states: Record<BaselineState, number>;
  hardFailures: number;
  fixtureViolations: number;
  networkAttempts: number;
  executionErrors: number;
  runLevelFailures: number;
  plannerDecisionCalls: number;
  /** Actual model gateway invocations of this execution (zero for scripted decisions). */
  modelInvocations: number;
  /** Same-run ledger model receipts, kept separate (may include historical attempts). */
  modelReceipts: number;
  fixtureProviderCalls: number;
  modelTokens: 'not_measured';
  modelCostUsd: 'not_measured';
  actualPaidCostUsd: null;
  fixtureFees: {
    measurement: 'simulated';
    knownSimulatedSubtotal: number | null;
    simulatedTotal: number | null;
    casesWithUnknownFee: number;
  };
}

export interface BaselineSourceMeta {
  datasetPath: string;
  datasetSha256: string;
  commit: string | null;
  dirty: boolean | null;
  dirtyPaths: number | null;
  nodeVersion: string;
  lockfile: { path: string; sha256: string };
  manifest: { path: string; sha256: string }[];
  manifestAggregateSha256: string;
}

export interface BaselineConfigMeta {
  execution: {
    fixtureProvider: string;
    injected: true;
    planner: string;
    modelGateway: string;
    transport: string;
    credentials: string;
    networkPolicy: string;
    baseLimits: Record<string, number>;
    sha256: string;
  };
  paths: { outputDir: string; tmpBase: string };
}

export interface BaselineBuildMeta {
  bootstrap: string;
  executedArtifacts: { path: string; sha256: string }[];
  aggregateSha256: string;
}

export interface BaselineGuardMeta {
  processIsolated: true;
  installedBeforeProductionImports: true;
  coveredApis: string[];
  violations: number;
  logArtifact: string;
  boundary: string;
}

export interface BaselineRunMeta {
  workerExitCode: number | null;
  workerSignal: string | null;
  guardInstalled: boolean;
  recordsFormat: string;
  failures: string[];
}

export interface BaselineReport {
  type: 'offline_controller_replay';
  datasetVersion: 'research-baseline-v1';
  labels: { track: string; boundary: string };
  generatedAt: string;
  totalMonotonicElapsedMs: number;
  config: BaselineConfigMeta;
  build: BaselineBuildMeta;
  source: BaselineSourceMeta;
  normalization: typeof VOLATILE_NORMALIZATION;
  guard: BaselineGuardMeta;
  run: BaselineRunMeta;
  runCommands: string[];
  summary: BaselineSummary;
  cases: BaselineCaseReport[];
  notEvaluated: string[];
}

export interface BuildReportInput {
  generatedAt: string;
  totalMonotonicElapsedMs: number;
  config: BaselineConfigMeta;
  build: BaselineBuildMeta;
  source: BaselineSourceMeta;
  guard: BaselineGuardMeta;
  run: BaselineRunMeta;
  runCommands: string[];
}

const STATES: BaselineState[] = ['completed', 'partial', 'needs_input', 'runner_error'];

export function buildReport(caseReports: BaselineCaseReport[], input: BuildReportInput): BaselineReport {
  const scheduled = caseReports.length;
  const passed = caseReports.filter((entry) => entry.structural === 'pass').length;
  const states: Record<BaselineState, number> = { completed: 0, partial: 0, needs_input: 0, runner_error: 0 };
  for (const entry of caseReports) states[entry.actual.state] += 1;

  let knownSimulatedSubtotal = 0;
  let hasKnownFee = false;
  let unknownFees = 0;
  let casesWithUnknownFee = 0;
  for (const entry of caseReports) {
    const usage = entry.actual.fixtureUsage;
    if (usage.knownSimulatedSubtotal !== null) {
      hasKnownFee = true;
      knownSimulatedSubtotal += usage.knownSimulatedSubtotal;
    }
    unknownFees += usage.unknownFeeReceipts;
    if (usage.unknownFeeReceipts > 0) casesWithUnknownFee += 1;
  }

  return {
    type: 'offline_controller_replay',
    datasetVersion: 'research-baseline-v1',
    labels: {
      track: 'offline controller replay (production runResearch + Store with injected scripted fixtures)',
      boundary: 'program-behaviour baseline only; unreviewed original synthetic fixtures, not human gold, not a research-quality benchmark'
    },
    generatedAt: input.generatedAt,
    totalMonotonicElapsedMs: input.totalMonotonicElapsedMs,
    config: input.config,
    build: input.build,
    source: input.source,
    normalization: VOLATILE_NORMALIZATION,
    guard: input.guard,
    run: input.run,
    runCommands: input.runCommands,
    summary: {
      scheduled,
      caseProgress: {
        started: caseReports.filter((entry) => entry.actual.completion !== 'not_run').length,
        finished: caseReports.filter((entry) => entry.actual.completion === 'finished').length,
        unfinished: caseReports.filter((entry) => entry.actual.completion === 'unfinished').length,
        notRun: caseReports.filter((entry) => entry.actual.completion === 'not_run').length
      },
      structural: { passed, failed: scheduled - passed },
      passRate: { value: scheduled > 0 ? passed / scheduled : null, denominator: scheduled },
      states,
      hardFailures: caseReports.filter((entry) => entry.hardFailure).length,
      fixtureViolations: caseReports.reduce((n, entry) => n + entry.actual.fixtureViolations.length, 0),
      networkAttempts: input.guard.violations,
      executionErrors: caseReports.filter((entry) => entry.actual.executionError !== null).length,
      runLevelFailures: input.run.failures.length,
      plannerDecisionCalls: caseReports.reduce((n, entry) => n + entry.actual.counts.plannerDecisionCalls, 0),
      modelInvocations: caseReports.reduce((n, entry) => n + entry.actual.counts.modelInvocations, 0),
      modelReceipts: caseReports.reduce((n, entry) => n + entry.actual.counts.modelReceipts, 0),
      fixtureProviderCalls: caseReports.reduce((n, entry) => n + entry.actual.counts.fixtureProviderCalls, 0),
      modelTokens: 'not_measured',
      modelCostUsd: 'not_measured',
      actualPaidCostUsd: null,
      fixtureFees: {
        measurement: 'simulated',
        knownSimulatedSubtotal: hasKnownFee ? knownSimulatedSubtotal : null,
        // Any unknown fee makes a complete total unknowable; never add one up.
        simulatedTotal: unknownFees > 0 ? null : hasKnownFee ? knownSimulatedSubtotal : null,
        casesWithUnknownFee
      }
    },
    cases: caseReports,
    notEvaluated: [
      'semantic_entailment: citations are structurally checked only; no human judged whether quotes support statements',
      'research_quality: coverage, identity precision and recall, and human verification cost are not evaluated',
      'model_usage: the scripted planner never invokes a model, so real token counts and model cost are not_measured, not zero',
      'provider_costs: fixture estimatedUsd values are simulated; unknown fees stay unknown and the simulatedTotal stays null when any fee is unknown',
      'os_network_isolation: the replay runs under a process-level network API guard, not under an OS network sandbox',
      'freeze_chronology: dataset expectations are versioned synthetic assertions with recorded hashes; no historical pre-registration is claimed'
    ]
  };
}

export function verifyReportConsistency(report: BaselineReport): string[] {
  const failures: string[] = [];
  const scheduled = report.cases.length;
  if (report.summary.scheduled !== scheduled) failures.push('summary.scheduled does not match the case count');
  const passed = report.cases.filter((entry) => entry.structural === 'pass').length;
  if (report.summary.structural.passed !== passed) failures.push('summary.structural.passed contradicts case verdicts');
  if (report.summary.structural.failed !== scheduled - passed) failures.push('summary.structural.failed contradicts case verdicts');
  if (report.summary.passRate.denominator !== scheduled) failures.push('summary.passRate.denominator must be all scheduled cases');
  if (scheduled > 0 && report.summary.passRate.value !== passed / scheduled) failures.push('summary.passRate.value contradicts case verdicts');
  const progress = report.summary.caseProgress;
  if (progress.started !== progress.finished + progress.unfinished) failures.push('summary.caseProgress.started must equal finished + unfinished');
  if (progress.finished + progress.notRun + progress.unfinished !== scheduled) {
    failures.push('summary.caseProgress must cover exactly the scheduled cases');
  }
  const stateTotal = STATES.reduce((n, key) => n + report.summary.states[key], 0);
  if (stateTotal !== scheduled) failures.push('summary.states must cover exactly the scheduled cases');
  for (const entry of report.cases) {
    const expected = entry.structural === 'pass';
    if (expected !== (entry.failures.length === 0)) failures.push(`case ${entry.caseId} verdict contradicts its failure list`);
    if (entry.hardFailure && entry.structural === 'pass') failures.push(`case ${entry.caseId} is marked hard failure but passed`);
    if (entry.actual.counts.modelInvocations !== 0) failures.push(`case ${entry.caseId} claims a model invocation in a no-model replay`);
  }
  if (report.summary.modelInvocations !== 0) failures.push('summary.modelInvocations must be 0 for the scripted replay');
  if (report.summary.modelTokens !== 'not_measured' || report.summary.modelCostUsd !== 'not_measured') {
    failures.push('model token/cost must be not_measured, never a fabricated zero');
  }
  if (report.summary.actualPaidCostUsd !== null) failures.push('actualPaidCostUsd must stay null (no paid call ran)');
  if (report.summary.fixtureFees.casesWithUnknownFee > 0 && report.summary.fixtureFees.simulatedTotal !== null) {
    failures.push('fixtureFees.simulatedTotal must be null while any fee is unknown');
  }
  return failures;
}

function renderReportMarkdown(report: BaselineReport): string {
  const lines: string[] = [];
  lines.push('# Research baseline v1 · 离线控制器回放');
  lines.push('');
  lines.push(`> ${report.labels.track}`);
  lines.push('');
  lines.push(`- 报告类型：\`${report.type}\`（与 runtime-v1 的 provider 契约回放 \`offline_provider_contract\` 分轨，互不替代）`);
  lines.push(`- 数据集：\`${report.source.datasetPath}\`（计划 ${report.summary.scheduled} 案例，SHA256 \`${report.source.datasetSha256.slice(0, 16)}…\`）`);
  lines.push(`- 数据来源：ORIGINAL synthetic 案例，全部 \`unreviewed\`，不是人工 gold，也不是研究质量 benchmark；期望是带哈希的版本化合成断言，不宣称历史上先于断言冻结`);
  lines.push(`- 源码版本：commit \`${report.source.commit ?? 'unknown'}\`${report.source.dirty ? '（dirty）' : ''} · Node ${report.source.nodeVersion} · lockfile SHA256 \`${report.source.lockfile.sha256.slice(0, 16)}…\``);
  lines.push(`- 源码清单聚合哈希：\`${report.source.manifestAggregateSha256.slice(0, 16)}…\` · 配置哈希：\`${report.config.execution.sha256.slice(0, 16)}…\` · 执行字节聚合哈希：\`${report.build.aggregateSha256.slice(0, 16)}…\``);
  lines.push(`- 引导方式：${report.build.bootstrap}`);
  lines.push(`- 网络边界：${report.guard.boundary}`);
  if (report.run.failures.length > 0) {
    lines.push('');
    lines.push('## 运行级失败');
    lines.push('');
    for (const failure of report.run.failures) lines.push(`- ${failure}`);
  }
  lines.push('');
  lines.push('## 结构结果（与研究状态分布分开）');
  lines.push('');
  lines.push(`- 计划 / 启动 / 完成 / 未完成 / 未运行：${report.summary.scheduled} / ${report.summary.caseProgress.started} / ${report.summary.caseProgress.finished} / ${report.summary.caseProgress.unfinished} / ${report.summary.caseProgress.notRun}`);
  lines.push(`- 全部计划案例计入分母；结构通过 / 失败：${report.summary.structural.passed} / ${report.summary.structural.failed}`);
  const rate = report.summary.passRate;
  lines.push(`- 通过率：${rate.value === null ? 'N/A' : rate.value.toFixed(3)}（分母 ${rate.denominator}）`);
  lines.push(`- 硬失败：${report.summary.hardFailures} · fixture 违规：${report.summary.fixtureViolations} · 网络 / 子进程越界尝试：${report.summary.networkAttempts} · 记录的执行错误：${report.summary.executionErrors}`);
  lines.push('');
  lines.push('## 研究状态分布（描述性，不是分数）');
  lines.push('');
  for (const key of STATES) lines.push(`- ${key}: ${report.summary.states[key]}`);
  lines.push('');
  lines.push('## 调用与费用记账');
  lines.push('');
  lines.push(`- 脚本化规划决策（plannerDecisionCalls）：${report.summary.plannerDecisionCalls}`);
  lines.push(`- 实际模型调用（modelInvocations）：${report.summary.modelInvocations}；同一次运行账本中的模型回执（modelReceipts）：${report.summary.modelReceipts}（可含历史恢复证据，不是本次调用）`);
  lines.push(`- 模型 token / 费用：\`${report.summary.modelTokens}\` / \`${report.summary.modelCostUsd}\`；实际支付费用：\`${String(report.summary.actualPaidCostUsd)}\``);
  lines.push(`- fixture 工具调用：${report.summary.fixtureProviderCalls}（注入的 \`${report.config.execution.fixtureProvider}\`）`);
  const fees = report.summary.fixtureFees;
  lines.push(`- fixture 声明费用（measurement=\`${fees.measurement}\`）：已知小计 ${fees.knownSimulatedSubtotal === null ? '无' : fees.knownSimulatedSubtotal}；完整模拟合计 ${fees.simulatedTotal === null ? 'null（存在未知费用，不给出误导性合计）' : fees.simulatedTotal}；含未知费用的案例 ${fees.casesWithUnknownFee}`);
  lines.push('');
  lines.push('## 逐案结构断言');
  lines.push('');
  lines.push('| case | scenario | 进度 | 期望状态 | 实际状态 | 结构 | 失败原因 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const entry of report.cases) {
    const failures = entry.failures.length > 0 ? entry.failures.map((item) => item.replace(/\|/g, '\\|')).join('<br>') : '—';
    lines.push(`| ${entry.caseId} | ${entry.scenario} | ${entry.actual.completion} | ${entry.expected.state} | ${entry.actual.state} | ${entry.structural} | ${failures} |`);
  }
  lines.push('');
  lines.push('## 哈希与可重现性');
  lines.push('');
  lines.push('- 每案记录 normalized result hash（显式归一化 ID / 时间戳 / 时长字段，回执按 kind+key 稳定排序后哈希）；`serialized` 是各原始子对象稳定序列化的哈希；`artifact` 是最终写盘字节的哈希，`manifest.json` 汇总全部产物文件哈希。');
  lines.push(`- 归一化字段：ids=${report.normalization.ids.join(', ')}；timestamps=${report.normalization.timestamps.join(', ')}；durations=${report.normalization.durations.join(', ')}。依赖结构（如 inheritedFrom.sourceKey 与 null/存在差异）不参与归一化。`);
  lines.push('');
  lines.push('## 未评估');
  lines.push('');
  for (const item of report.notEvaluated) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## 运行命令');
  lines.push('');
  for (const command of report.runCommands) lines.push(`- \`${command}\``);
  lines.push('');
  return lines.join('\n');
}

export function renderMarkdown(report: BaselineReport): string {
  return renderReportMarkdown(report);
}
