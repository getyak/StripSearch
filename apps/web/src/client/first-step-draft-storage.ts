/** Optional browser draft cache. It records user input, never server authority. */
import type { FirstStepDecisionDraft } from './first-step.js';

export interface FirstStepSavedDraft {
  caseId: string;
  scopeVersion: number;
  clusterId: string | null;
  decisions: Array<[string, FirstStepDecisionDraft]>;
  hint: string;
  submitKey: string | null;
  submitIntent: string | null;
  sequence: number;
}
interface DraftEnvelope extends FirstStepSavedDraft { version: 1; ownerId: string; runId: string }
const PREFIX = 'stripsearch:first-step-draft:v1:';
const MAX_BYTES = 128_000;
const STATES = new Set(['selected', 'not_selected', 'only_this_account', 'unanswered']);
function browserStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function firstStepDraftCache(ownerId: string | undefined, runId: string, storage = browserStorage()) {
  const key = ownerId ? `${PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(runId)}` : null;
  const remove = (): void => { try { if (key) storage?.removeItem(key); } catch { /* cache is optional */ } };
  return {
    read(caseId: string, scopeVersion: number): FirstStepSavedDraft | null {
      if (!key || !storage) return null;
      try {
        const raw = storage.getItem(key);
        if (!raw || raw.length > MAX_BYTES) return null;
        const value = JSON.parse(raw) as Partial<DraftEnvelope>;
        if (value.version !== 1 || value.ownerId !== ownerId || value.runId !== runId || value.caseId !== caseId || value.scopeVersion !== scopeVersion) return null;
        if (typeof value.clusterId !== 'string' && value.clusterId !== null) return null;
        if (!Array.isArray(value.decisions) || value.decisions.length > 512) return null;
        const ids = new Set<string>();
        for (const item of value.decisions) {
          if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || item[0].length > 128 || ids.has(item[0])) return null;
          const decision = item[1];
          if (!decision || !STATES.has(decision.selection) || typeof decision.excluded !== 'boolean') return null;
          ids.add(item[0]);
        }
        if (typeof value.hint !== 'string' || value.hint.length > 500 || !Number.isSafeInteger(value.sequence) || value.sequence! < 0) return null;
        if (value.submitKey !== null && (typeof value.submitKey !== 'string' || value.submitKey.length > 128)) return null;
        if (value.submitIntent !== null && (typeof value.submitIntent !== 'string' || value.submitIntent.length > MAX_BYTES)) return null;
        return value as FirstStepSavedDraft;
      } catch { return null; }
    },
    write(value: FirstStepSavedDraft): void {
      if (!key || !storage || !ownerId || value.decisions.length > 512) return;
      try {
        const raw = JSON.stringify({ ...value, version: 1, ownerId, runId } satisfies DraftEnvelope);
        if (raw.length <= MAX_BYTES) storage.setItem(key, raw);
      } catch { /* disabled/full storage must not break selecting or submitting */ }
    },
    remove
  };
}

export function clearFirstStepDrafts(ownerId: string, storage = browserStorage()): void {
  try {
    if (!storage) return;
    const prefix = `${PREFIX}${encodeURIComponent(ownerId)}:`;
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key !== null && key.startsWith(prefix));
    for (const key of keys) storage.removeItem(key);
  } catch { /* signing out cannot depend on cache availability */ }
}
