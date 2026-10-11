import {classifyFirstStepUrl,type FirstStepAccountRef} from '../../shared/first-step-discovery.js';
import type {ResearchAliasProof} from './tool-contracts.js';

export type FirstStepAliasProjection =
  | { ok: true; aliasKey: string; representativeKey: string; aliasRef: FirstStepAccountRef; representativeRef: FirstStepAccountRef }
  | { ok: false; reason: string };

/**
 * Re-verify one adapter-generated alias proof before any projection rewrite.
 * Trusted kinds only: (1) an actual native GitHub/X profile response with a
 * stable nonempty native id — same platform, one profile, only a case alias;
 * (2) an actual same-document redirect whose final URL differs only in the
 * www/apex host prefix with EXACTLY the same pathname+query and BOTH sides
 * classifier profile entries. Arbitrary paths, domains, subdomains, different
 * handles/native ids and cross-platform lookalikes never collapse. The
 * returned ref is the representative; this function creates no identity
 * support and no scope permission.
 */
export function verifyAliasProjection(proof: ResearchAliasProof): FirstStepAliasProjection {
  if(proof.kind!=='native_profile'&&proof.kind!=='same_document_redirect')return {ok:false,reason:'未支持的别名证明类型。'};
  const requested = classifyFirstStepUrl(proof.requestedUrl);
  const returned = classifyFirstStepUrl(proof.returnedUrl);
  if (!requested.ok || !returned.ok) return { ok: false, reason: '别名证明的请求或返回地址不是可分类的公开链接。' };
  const aliasRef = requested.ref;
  const representativeRef = returned.ref;
  if (proof.kind === 'native_profile') {
    if (proof.platform !== 'github' && proof.platform !== 'x') return { ok: false, reason: '原生别名只支持 GitHub/X 平台。' };
    if (typeof proof.nativeId !== 'string' || !/^[0-9]+$/.test(proof.nativeId)) return { ok: false, reason: '原生别名缺少稳定非空原生 ID。' };
    if (aliasRef.platform !== proof.platform || representativeRef.platform !== proof.platform) return { ok: false, reason: '原生别名必须是同一平台的同一账号。' };
    if (aliasRef.entry !== 'profile' || representativeRef.entry !== 'profile') return { ok: false, reason: '原生别名只在 profile 入口之间成立。' };
    if (aliasRef.handle === null || representativeRef.handle === null || aliasRef.handle.toLowerCase() !== representativeRef.handle.toLowerCase()) {
      return { ok: false, reason: '原生别名只允许同一账号的大小写别名；不同账号或不同原生 ID 永不合并。' };
    }
    return { ok: true, aliasKey: aliasRef.accountKey, representativeKey: representativeRef.accountKey, aliasRef, representativeRef };
  }
  const urlA = new URL(proof.requestedUrl);
  const urlB = new URL(proof.returnedUrl);
  const baseA = urlA.hostname.replace(/^www\./, '');
  const baseB = urlB.hostname.replace(/^www\./, '');
  if (baseA !== baseB || urlA.hostname === urlB.hostname) return { ok: false, reason: '文档别名只允许同一主机的 www/apex 变体。' };
  if (urlA.hostname !== `www.${urlB.hostname}` && urlB.hostname !== `www.${urlA.hostname}`) return { ok: false, reason: '文档别名只允许 www/apex 主机前缀差异。' };
  if (urlA.pathname !== urlB.pathname || urlA.search !== urlB.search) return { ok: false, reason: '文档别名要求完全相同的路径与查询；不同路径永不合并。' };
  if (aliasRef.platform !== representativeRef.platform || aliasRef.entry !== 'profile' || representativeRef.entry !== 'profile') {
    return { ok: false, reason: '文档别名要求两侧都是同一平台的 profile 入口。' };
  }
  return { ok: true, aliasKey: aliasRef.accountKey, representativeKey: representativeRef.accountKey, aliasRef, representativeRef };
}

