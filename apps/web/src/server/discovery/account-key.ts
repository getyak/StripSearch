/**
 * GET-92 account keys: conservative canonical account identity and
 * candidate origin merging.
 *
 * Rules (see `shared/discovery-plan.ts` and the primary-source notes):
 *
 * - Native ids are opaque STRINGS keyed FIRST and ONLY with a verified
 *   issuer namespace (platform + instance + account kind bound in). A home
 *   instance is never the issuer of a remote/federated account, so the same
 *   opaque id from two API issuers never merges.
 * - URL fallback accepts only public-safe HTTPS and canonicalizes
 *   conservatively: scheme/host case is normalized (host case is not
 *   identity, matching the GET-91 template canonicalization), while path
 *   case, encoded slashes, trailing slashes, identity queries and identity
 *   fragments stay verbatim. Tracking parameters are stripped ONLY through
 *   an explicit verified per-platform whitelist (empty by default).
 * - Handle fallback keeps the observed case (no default casefold from a
 *   platform label), binds instance + account kind, and only accepts
 *   VERIFIED handles: `invalid_handle` placeholders are never handles and a
 *   remote acct (`user@domain`) is preserved as a domain-bound handle —
 *   never treated as an email.
 * - `mergeCandidateOrigins` merges on equal canonical keys or a
 *   deterministic provider association proof — never on display name, host,
 *   username or similarity. It keeps every distinct origin (structural
 *   dedupe only), retains contradictory id/actor/home/kind evidence as
 *   explicit conflicts and never resets existing selection facets or
 *   inflates identity support / user choice / reading scope.
 */

import type {
  AccountAssociationProof,
  CandidateConflict,
  CandidateDraft,
  CandidateMergeBasis,
  CandidateOrigin,
  DiscoveredAccountIdentity
} from '../../shared/discovery-plan.js';
import { ACCOUNT_KEY_PREFIX, canonicalJson } from '../../shared/discovery-plan.js';
import { normalizeSchemeHost, staticHttpsUrlPreflight } from './route-planner.js';

/** Verified per-platform canonicalization evidence. Empty by default. */
export interface AccountKeyRules {
  /** Platforms with VERIFIED handle case-fold evidence. Never guessed. */
  caseFoldHandlePlatforms: ReadonlySet<string>;
  /** Verified per-platform tracking-parameter whitelist. Never guessed. */
  trackingParamWhitelist: ReadonlyMap<string, readonly string[]>;
}

/** No case folding and no tracking stripping without verified evidence. */
export const NO_ACCOUNT_KEY_RULES: AccountKeyRules = {
  caseFoldHandlePlatforms: new Set<string>(),
  trackingParamWhitelist: new Map()
};

export class CandidateMergeError extends Error {
  constructor(readonly reasonCode: string, detail: string) {
    super(detail);
    this.name = 'CandidateMergeError';
  }
}

/* ------------------------------------------------------------------ */
/* Conservative URL canonicalization                                   */
/* ------------------------------------------------------------------ */

/**
 * Public-safe conservative profile URL canonicalization. The ONE shared
 * static URL preflight (also used by request keys, planned requests and
 * selflinks) refuses control characters, invalid authorities, userinfo,
 * localhost/non-public literal IPs, credential query AND fragment
 * metadata, and URLs HTTP parsing would rewrite. Only whitelisted tracking
 * parameters are stripped and everything else stays byte exact.
 */
function canonicalProfileUrl(raw: string, platformId: string, rules: AccountKeyRules): string | null {
  if (!staticHttpsUrlPreflight(raw).ok) return null;

  const hashIndex = raw.indexOf('#');
  const queryIndex = raw.indexOf('?');
  const hasQuery = queryIndex >= 0 && (hashIndex < 0 || queryIndex < hashIndex);
  const whitelist = rules.trackingParamWhitelist.get(platformId) ?? [];
  if (!hasQuery || whitelist.length === 0) return normalizeSchemeHost(raw);

  // Strip ONLY the explicitly whitelisted names, keeping every other pair
  // (duplicates, order and raw spelling) exactly as observed.
  const queryEnd = hashIndex >= 0 ? hashIndex : raw.length;
  const queryRaw = raw.slice(queryIndex + 1, queryEnd);
  const kept = queryRaw
    .split('&')
    .filter((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq >= 0 ? pair.slice(0, eq) : pair;
      let name = rawName;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
      return !whitelist.includes(name.trim());
    });
  const tail = hashIndex >= 0 ? raw.slice(hashIndex) : '';
  const query = kept.length > 0 ? `?${kept.join('&')}` : '';
  return normalizeSchemeHost(`${raw.slice(0, queryIndex)}${query}${tail}`);
}

/* ------------------------------------------------------------------ */
/* Canonical account key                                               */
/* ------------------------------------------------------------------ */

/**
 * Conservative canonical account key: native id (verified issuer) first,
 * then public-safe canonical URL, then verified handle + instance + kind.
 * Returns null when nothing conservative exists — the caller keeps the
 * unresolved evidence instead of inventing a key.
 */
export function canonicalAccountKey(
  identity: DiscoveredAccountIdentity,
  rules: AccountKeyRules = NO_ACCOUNT_KEY_RULES
): string | null {
  if (identity.platformId.trim().length === 0) return null;
  const base = {
    v: ACCOUNT_KEY_PREFIX,
    platformId: identity.platformId,
    instance: identity.instance === null ? null : identity.instance.toLowerCase(),
    accountKind: identity.accountKind
  };

  // 1) Opaque native id — ONLY with a verified issuer namespace.
  if (
    identity.nativeId !== null &&
    identity.nativeId !== '' &&
    identity.nativeIdIssuer !== null &&
    identity.nativeIdIssuer !== ''
  ) {
    return `${ACCOUNT_KEY_PREFIX}:${canonicalJson({
      ...base,
      mode: 'native',
      issuer: identity.nativeIdIssuer,
      nativeId: identity.nativeId
    })}`;
  }

  // 2) Conservative public-safe HTTPS URL fallback.
  if (identity.profileUrl !== null) {
    const url = canonicalProfileUrl(identity.profileUrl, identity.platformId, rules);
    if (url !== null) {
      return `${ACCOUNT_KEY_PREFIX}:${canonicalJson({ ...base, mode: 'url', url })}`;
    }
  }

  // 3) Verified handle with instance + account kind. Placeholders
  //    (`invalid_handle`) and unverified handles are never handles.
  if (
    identity.handleVerified === true &&
    identity.handle !== null &&
    identity.handle !== '' &&
    identity.handle !== 'invalid_handle'
  ) {
    const handle = rules.caseFoldHandlePlatforms.has(identity.platformId)
      ? identity.handle.toLowerCase()
      : identity.handle;
    return `${ACCOUNT_KEY_PREFIX}:${canonicalJson({ ...base, mode: 'handle', handle })}`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Candidate drafts and merging                                        */
/* ------------------------------------------------------------------ */

/** Validate all copied URL evidence even when a native ID supplies the key. */
function assertPublicIdentityUrls(identity: DiscoveredAccountIdentity): void {
  const urls = [identity.profileUrl, identity.actorUrl, ...(identity.associationProof?.urls ?? [])];
  if (urls.some((url) => url !== null && !staticHttpsUrlPreflight(url).ok)) {
    throw new CandidateMergeError(
      'unsafe_identity_url',
      'candidate URL metadata must pass the public HTTPS preflight before materialization'
    );
  }
}

/** Independent deep snapshots: callers can never alias draft evidence. */
function snapshotIdentity(identity: DiscoveredAccountIdentity): DiscoveredAccountIdentity {
  return {
    ...identity,
    associationProof:
      identity.associationProof === null
        ? null
        : {
            basis: identity.associationProof.basis,
            evidenceRef: identity.associationProof.evidenceRef,
            nativeIds: identity.associationProof.nativeIds.map((item) => ({ ...item })),
            urls: [...identity.associationProof.urls]
          }
  };
}

function snapshotOrigin(origin: CandidateOrigin): CandidateOrigin {
  return { ...origin, provenance: { ...origin.provenance, sourceRefs: [...origin.provenance.sourceRefs] } };
}

function snapshotConflict(conflict: CandidateConflict): CandidateConflict {
  return { ...conflict, originIds: [...conflict.originIds] };
}

function structuralDedupe<T>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = canonicalJson(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * A new discovered candidate: identity evidence, proof and origins are
 * snapshotted so later caller mutation can never alias the draft, and
 * identity support stays `proposed`, user choice `unanswered` and allowed
 * scope `none`. Discovery never proves identity, never selects and never
 * grants reading scope.
 */
export function newCandidateDraft(
  identity: DiscoveredAccountIdentity,
  origins: CandidateOrigin[],
  observedAt: string
): CandidateDraft {
  assertPublicIdentityUrls(identity);
  return {
    identity: snapshotIdentity(identity),
    canonicalKey: canonicalAccountKey(identity),
    mergeBasis: null,
    origins: origins.map(snapshotOrigin),
    conflicts: [],
    identitySupport: {
      state: 'proposed',
      evidenceIds: [],
      counterevidenceIds: [],
      policyVersion: 'stripsearch/discovery-plan/v1',
      note: `discovery candidate observed ${observedAt}`
    },
    userSelection: { state: 'unanswered', note: null, recordedAt: null },
    allowedScope: { state: 'none', note: null }
  };
}

const SUPPORTED_PROOF_BASES = new Set<AccountAssociationProof['basis']>([
  'same_actor_uri',
  'provider_identity_mapping'
]);

/** A proof must name a supported basis and a non-empty locatable receipt. */
function proofDefect(proof: AccountAssociationProof): string | null {
  if (!SUPPORTED_PROOF_BASES.has(proof.basis)) return 'unsupported association proof basis';
  if (typeof proof.evidenceRef !== 'string' || proof.evidenceRef.trim().length === 0) {
    return 'association proof needs a non-empty locatable evidence reference';
  }
  if (!Array.isArray(proof.nativeIds) || !Array.isArray(proof.urls)) return 'malformed association proof';
  for (const native of proof.nativeIds) {
    if (
      typeof native.id !== 'string' ||
      native.id.length === 0 ||
      typeof native.issuer !== 'string' ||
      native.issuer.length === 0
    ) {
      return 'association proof native ids need a non-empty id and verified issuer namespace';
    }
  }
  for (const url of proof.urls) {
    if (typeof url !== 'string' || url.length === 0) return 'malformed association proof url';
  }
  return null;
}

/** Exact evidence binding only — never names, hosts or similarity. */
function proofBinds(proof: AccountAssociationProof, identity: DiscoveredAccountIdentity): boolean {
  if (
    identity.nativeId !== null &&
    identity.nativeId !== '' &&
    identity.nativeIdIssuer !== null &&
    identity.nativeIdIssuer !== '' &&
    proof.nativeIds.some((item) => item.id === identity.nativeId && item.issuer === identity.nativeIdIssuer)
  ) {
    return true;
  }
  if (identity.profileUrl !== null && proof.urls.includes(identity.profileUrl)) return true;
  if (identity.actorUrl !== null && proof.urls.includes(identity.actorUrl)) return true;
  return false;
}

function proofLinks(existing: DiscoveredAccountIdentity, incoming: DiscoveredAccountIdentity): boolean {
  for (const proof of [existing.associationProof, incoming.associationProof]) {
    if (proof === null) continue;
    if (proofBinds(proof, existing) && proofBinds(proof, incoming)) return true;
  }
  return false;
}

const IDENTITY_FIELDS = [
  'nativeId',
  'nativeIdIssuer',
  'profileUrl',
  'actorUrl',
  'homeInstance',
  'handle',
  'accountKind',
  'instance'
] as const;

/**
 * Merge two drafts established as the same candidate (equal recomputed
 * canonical key or a valid deterministic association proof binding BOTH
 * identities). The authoritative key is recomputed from the current identity
 * evidence: a stale/forged stored key is refused instead of merging across
 * accounts or carrying selection/scope onto another identity. Both historical
 * conflict arrays survive with only byte-identical structural dedupe;
 * contradictory id/actor/home/kind evidence is retained with all origins and
 * original fields/values/originIds/notes; existing selection facets are kept
 * as-is. Unproven association never merges.
 */
export function mergeCandidateOrigins(existing: CandidateDraft, incoming: CandidateDraft): CandidateDraft {
  assertPublicIdentityUrls(existing.identity);
  assertPublicIdentityUrls(incoming.identity);
  for (const draft of [existing, incoming]) {
    for (const conflict of draft.conflicts) {
      if (conflict.field !== 'profileUrl' && conflict.field !== 'actorUrl') continue;
      if ([conflict.existing, conflict.incoming].some((url) => url !== null && !staticHttpsUrlPreflight(url).ok)) {
        throw new CandidateMergeError('unsafe_identity_url', 'historical URL evidence must pass the public HTTPS preflight');
      }
    }
  }
  if (existing.identity.platformId !== incoming.identity.platformId) {
    throw new CandidateMergeError(
      'platform_conflict',
      `platforms are an identity boundary: ${existing.identity.platformId} vs ${incoming.identity.platformId}`
    );
  }
  const authoritativeKey = (draft: CandidateDraft, label: string): string | null => {
    const recomputed = canonicalAccountKey(draft.identity);
    if ((draft.canonicalKey ?? null) !== recomputed) {
      throw new CandidateMergeError(
        'stale_canonical_key',
        `the ${label} draft carries a stale/forged canonical key that no longer describes its identity evidence`
      );
    }
    return recomputed;
  };
  const keyExisting = authoritativeKey(existing, 'existing');
  const keyIncoming = authoritativeKey(incoming, 'incoming');

  // Any association proof must be well-formed BEFORE it is consulted.
  for (const [label, proof] of [
    ['existing', existing.identity.associationProof],
    ['incoming', incoming.identity.associationProof]
  ] as Array<[string, AccountAssociationProof | null]>) {
    if (proof === null) continue;
    const defect = proofDefect(proof);
    if (defect !== null) {
      throw new CandidateMergeError('invalid_association_proof', `the ${label} proof is unusable: ${defect}`);
    }
  }

  let mergeBasis: CandidateMergeBasis;
  if (keyExisting !== null && keyExisting === keyIncoming) {
    mergeBasis = 'canonical_key';
  } else if (proofLinks(existing.identity, incoming.identity)) {
    mergeBasis = 'association_proof';
  } else {
    const proofPresent = existing.identity.associationProof !== null || incoming.identity.associationProof !== null;
    throw new CandidateMergeError(
      proofPresent ? 'invalid_association_proof' : 'unproven_association',
      proofPresent
        ? 'the association proof does not bind BOTH identities by native id + verified issuer or actor/profile URL evidence'
        : 'no canonical key or deterministic association proof links these identities; they keep separate keys'
    );
  }

  const origins = structuralDedupe([...existing.origins, ...incoming.origins].map(snapshotOrigin));
  const originIds = origins.map((origin) => origin.originId);
  const derived: CandidateConflict[] = [];
  for (const field of IDENTITY_FIELDS) {
    const before = existing.identity[field];
    const after = incoming.identity[field];
    if (before === after) continue;
    derived.push({
      field,
      existing: before === null ? null : String(before),
      incoming: after === null ? null : String(after),
      originIds,
      note: '冲突/替代证据整体保留，不作身份裁决（归属裁决属 GET-64）'
    });
  }
  // BOTH sides' history survives every merge stage (structural dedupe only).
  const conflicts = structuralDedupe(
    [...existing.conflicts, ...incoming.conflicts, ...derived].map(snapshotConflict)
  );

  return {
    identity: snapshotIdentity(existing.identity),
    canonicalKey: keyExisting,
    mergeBasis,
    origins,
    conflicts,
    // Existing facets are authoritative: merging never resets a user's
    // selection or scope and never upgrades identity support.
    identitySupport: {
      ...existing.identitySupport,
      evidenceIds: [...existing.identitySupport.evidenceIds],
      counterevidenceIds: [...existing.identitySupport.counterevidenceIds]
    },
    userSelection: { ...existing.userSelection },
    allowedScope: { ...existing.allowedScope }
  };
}

export type { AccountAssociationProof };
