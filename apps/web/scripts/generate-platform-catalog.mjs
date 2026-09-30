#!/usr/bin/env node
/**
 * Maintenance generator for the GET-90 versioned platform catalog data.
 *
 * Re-emits `data/platforms/catalog.json` and `data/platforms/manifest.json`
 * with the same canonical content-hash algorithm the loader enforces
 * (`src/server/platforms/catalog.ts`). The shipped JSON files remain the
 * runtime authority: `loadPlatformCatalog` re-verifies both hashes on every
 * load, so this script cannot silently diverge from the verified data.
 *
 * Evidence policy (enforced by loader + tests):
 * - `documentation: 'documented'` only where a concrete endpoint fact or a
 *   precise original source locator exists; generic developer-doc links never
 *   establish a capability dimension.
 * - Canonical profile URL rules stay null unless an explicit documented
 *   pattern is cited; nothing is synthesized from the homepage.
 * - Integration marks only actual adapters/operation handlers; existence
 *   probes are not profile readers.
 * - Access and price belong to the actual operation/route per dimension;
 *   mixed-source platforms never inherit one route's conditions everywhere.
 *   Unknown prices are explicit null with a public basis; null ≠ free.
 *
 * Frozen public-source metadata (versions/hashes/retrieval) comes from the
 * parent's public-sources cache manifests; source bytes are NOT vendored and
 * rule import stays GET-91 (`metadata_only_not_imported`).
 *
 * Usage: `node scripts/generate-platform-catalog.mjs` from `apps/web`.
 * Offline by design: it never fetches upstream documentation.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'platforms');
const SCHEMA = 'stripsearch/platform-catalog/v1';
const MANIFEST_SCHEMA = 'stripsearch/platform-catalog-manifest/v1';
const VERSION = '2026-09-30.1';
const GENERATED = '2026-09-30';

const TIKHUB_PRICE_URL = 'https://api.tikhub.io/api/v1/tikhub/user/get_all_endpoints_info';
const TIKHUB_OPENAPI_URL = 'https://api.tikhub.io/openapi.json';

/* ------------------------------------------------------------------ */
/* Source manifests — frozen metadata only, no bytes vendored           */
/* ------------------------------------------------------------------ */

const SOURCES = [
  {
    sourceId: 'tikhub-openapi',
    kind: 'provider_openapi',
    title: 'TikHub OpenAPI 端点目录（公开）',
    url: TIKHUB_OPENAPI_URL,
    license: null,
    licenseHash: null,
    upstreamVersion: 'V5.3.2',
    upstreamState: 'frozen',
    capturedAt: '2026-09-30T05:29:49.939125+00:00',
    contentHash: 'b97eb0f6331b5709da1ab789359d48efabe177c4ebdcd83078b7e57e9b8709c5',
    bytes: 3069811,
    importerVersion: null,
    counts: { raw: null, loaded: null, excluded: null },
    notes: [
      'V5.3.2 列出 1050 条路径；端点登记是文档事实，不代表端点已验证、已接入或可用。',
      '来源字节不入库；版本与 hash 由公共来源缓存核对（2026-09-30）。'
    ]
  },
  {
    sourceId: 'tikhub-endpoint-pricing',
    kind: 'provider_pricing',
    title: 'TikHub 公开端点价格元数据',
    url: TIKHUB_PRICE_URL,
    license: null,
    licenseHash: null,
    upstreamVersion: null,
    upstreamState: 'frozen',
    capturedAt: '2026-09-30T05:29:52.873261+00:00',
    contentHash: '859e6687762f4b4c54324f6d15165c85b0ae4d1668cd7b9d29601297b3cda882',
    bytes: 307821,
    importerVersion: null,
    counts: { raw: null, loaded: null, excluded: null },
    notes: [
      '响应包装含 request_id/time 等随请求变化的字段，不作为费用回执；目录价格按端点计价，不是项目账单。',
      '币种与选定端点未确定前金额保持 null；null 不等于免费。'
    ]
  },
  {
    sourceId: 'github-rest-docs',
    kind: 'official_documentation',
    title: 'GitHub REST API 官方文档',
    url: 'https://docs.github.com/en/rest',
    license: null,
    licenseHash: null,
    upstreamVersion: null,
    upstreamState: 'checked_unfrozen',
    capturedAt: GENERATED,
    contentHash: null,
    bytes: null,
    importerVersion: null,
    counts: { raw: null, loaded: null, excluded: null },
    notes: ['GitHub 能力的文档依据入口；不复制第三方文档全文。']
  },
  {
    sourceId: 'platform-official-docs',
    kind: 'official_documentation',
    title: '各平台官方公开开发者文档（仅作入口登记）',
    url: null,
    license: null,
    licenseHash: null,
    upstreamVersion: null,
    upstreamState: 'checked_unfrozen',
    capturedAt: GENERATED,
    contentHash: null,
    bytes: null,
    importerVersion: null,
    counts: { raw: null, loaded: null, excluded: null },
    notes: ['通用开发者文档入口不构成逐能力证据；无端点事实/精确来源定位的能力一律记 unknown。']
  },
  {
    sourceId: 'project-legacy-registry',
    kind: 'project_baseline',
    title: '既有平台探测规则基线（apps/web/src/server/platforms/registry.ts）',
    url: null,
    license: 'Apache-2.0',
    licenseHash: null,
    upstreamVersion: '2026-09-27.1',
    upstreamState: 'frozen',
    capturedAt: GENERATED,
    contentHash: null,
    bytes: null,
    importerVersion: null,
    counts: { raw: null, loaded: null, excluded: null },
    notes: ['13 条旧探测/帖子规则与既有验证标签原样保留；GitHub 规则的 live_verified 标签只描述旧规则语义。']
  },
  {
    sourceId: 'project-reddit-routes',
    kind: 'project_baseline',
    title: 'Reddit 两条接入路线核对（docs/platforms/reddit-routes.md）',
    url: null,
    license: 'Apache-2.0',
    licenseHash: null,
    upstreamVersion: '2026-09-30',
    upstreamState: 'frozen',
    capturedAt: GENERATED,
    contentHash: null,
    bytes: null,
    importerVersion: null,
    counts: { raw: null, loaded: null, excluded: null },
    notes: ['仅文档核对；两条 Reddit 路线均未启用、未 live 验证。']
  },
  {
    sourceId: 'maigret',
    kind: 'public_rule_dataset',
    title: 'Maigret 公开账号规则来源',
    url: 'https://raw.githubusercontent.com/soxoj/maigret/b6642744988e7e6c2d21f75db60ec3093019ba25/maigret/resources/data.json',
    license: 'MIT',
    licenseHash: '9748c279c95c58e64cc9e538e8c717ae9dce66bbed1d69e7d3e77e431d7e582d',
    upstreamVersion: 'b6642744988e7e6c2d21f75db60ec3093019ba25',
    upstreamState: 'metadata_only_not_imported',
    capturedAt: '2026-09-30T05:30:59.298392+00:00',
    contentHash: '3ac973e44f765c1c2b851571bd165f45145d0a00231c8ea97fb479e93f6aa289',
    bytes: 2496965,
    importerVersion: null,
    counts: { raw: null, loaded: null, excluded: null },
    notes: [
      'GET-91 才执行规则编译与导入；本目录只冻结来源元数据，没有导入或启用任何规则。',
      '来源仓库 https://github.com/soxoj/maigret（MIT，Copyright 2020-2026 Soxoj）；LICENSE 文本 hash 已核对。',
      '来源数据集含 6206 个站点记录（sites），这是来源记录数，不是导入数；raw/loaded/excluded 保持 null。'
    ]
  },
  {
    sourceId: 'whatsmyname',
    kind: 'public_rule_dataset',
    title: 'WhatsMyName 公开账号规则来源',
    url: 'https://raw.githubusercontent.com/WebBreacher/WhatsMyName/062bcfe48df79fa618e96edc79dc9673f3fe5643/wmn-data.json',
    license: 'CC BY-SA 4.0',
    licenseHash: '3eab49aa5cabc24918c11aab97dfe8873e0641317b898d989c993c4283a4d84b',
    upstreamVersion: '062bcfe48df79fa618e96edc79dc9673f3fe5643',
    upstreamState: 'metadata_only_not_imported',
    capturedAt: '2026-09-30T05:31:03.956135+00:00',
    contentHash: '507d2f8aa5b1297ae2d713634ccc7ce08357fed85b1d40130585810f456c1cfe',
    bytes: 259104,
    importerVersion: null,
    counts: { raw: null, loaded: null, excluded: null },
    notes: [
      'GET-91 才执行规则编译与导入；本目录只冻结来源元数据，没有导入或启用任何规则。',
      '来源仓库 https://github.com/WebBreacher/WhatsMyName（CC BY-SA 4.0，Copyright 2015-2026 Micah Hoffman）；LICENSE 文本 hash 已核对。',
      '来源数据集含 717 个站点记录（sites），这是来源记录数，不是导入数；raw/loaded/excluded 保持 null。',
      '导入时保留 CC BY-SA 4.0 归属与修改说明。'
    ]
  }
];

/* ------------------------------------------------------------------ */
/* Cost facts (all amounts null: nothing was measured)                 */
/* ------------------------------------------------------------------ */

function unknownPriceCost(basis) {
  return {
    provider: null,
    unit: null,
    currency: null,
    amount: null,
    asOf: GENERATED,
    source: null,
    basis,
    conditions: null
  };
}

function tikhubCost() {
  return {
    provider: 'tikhub',
    unit: null,
    currency: null,
    amount: null,
    asOf: GENERATED,
    source: TIKHUB_PRICE_URL,
    basis: 'TikHub 公开价格目录（hash 859e6687…）按端点列 endpoint_cost，未标币种/计量单位；未选定具体端点，金额保持 null',
    conditions: '目录响应含随请求变化的 request_id/time，不作为费用回执；null 不等于免费'
  };
}

function githubCost() {
  return {
    provider: null,
    unit: null,
    currency: null,
    amount: null,
    asOf: GENERATED,
    source: 'https://docs.github.com/en/rest',
    basis: 'GitHub REST 公开定价未逐端点核对（2026-09-30 核对），金额保持 null；null 不等于免费',
    conditions: '认证请求限速更高；实际费用未测量'
  };
}

const NO_PRICE = unknownPriceCost('未核对到该操作的公开定价来源（2026-09-30 核对），金额保持 null；null 不等于免费');
const NO_OPERATION_PRICE = unknownPriceCost('未建立对应操作端点，费用无从核对（2026-09-30 核对），金额保持 null；null 不等于免费');

/* ------------------------------------------------------------------ */
/* Evidence tables (facts from pinned sources; nothing invented)       */
/* ------------------------------------------------------------------ */

const DIMENSIONS = ['discovery', 'profile', 'list', 'body', 'media', 'comments', 'pagination'];

/**
 * TikHub path facts per platform from the pinned V5.3.2 OpenAPI / path index.
 * `paths` are documented endpoint facts, not enabled adapters.
 */
const TIKHUB = {
  douyin: {
    discovery: [{ path: '/api/v1/douyin/douplus/search_user_v2', method: 'POST', requestBody: 'UserSearchV2Request' }],
    profile: [{ path: '/api/v1/douyin/web/fetch_user_profile_by_uid', method: 'GET' }],
    list: ['/api/v1/douyin/app/v3/fetch_user_post_videos'],
    body: ['/api/v1/douyin/app/v3/fetch_one_video'],
    comments: ['/api/v1/douyin/app/v3/fetch_video_comments', '/api/v1/douyin/app/v3/fetch_video_comment_replies'],
    media: ['/api/v1/douyin/app/v3/fetch_video_high_quality_play_url'],
    pagination: { endpoint: '/api/v1/douyin/app/v3/fetch_user_post_videos', params: 'max_cursor/count/sort_type', cursor: 'supported', note: 'sort_type 参数已登记，排序枚举未核对' }
  },
  tiktok: {
    discovery: ['/api/v1/tiktok/app/v3/get_user_id_and_sec_user_id_by_username'],
    profile: ['/api/v1/tiktok/web/fetch_user_profile'],
    list: ['/api/v1/tiktok/app/v3/fetch_user_post_videos'],
    body: ['/api/v1/tiktok/app/v3/fetch_one_video'],
    comments: ['/api/v1/tiktok/app/v3/fetch_video_comments', '/api/v1/tiktok/app/v3/fetch_video_comment_replies'],
    pagination: { endpoint: '/api/v1/tiktok/app/v3/fetch_user_post_videos', params: 'max_cursor/count/sort_type', cursor: 'supported', note: 'sort_type 参数已登记，排序枚举未核对' }
  },
  xiaohongshu: {
    discovery: ['/api/v1/xiaohongshu/app_v2/search_users'],
    profile: ['/api/v1/xiaohongshu/app_v2/get_user_info'],
    list: ['/api/v1/xiaohongshu/app_v2/get_user_posted_notes'],
    body: ['/api/v1/xiaohongshu/app_v2/get_image_note_detail'],
    comments: ['/api/v1/xiaohongshu/app_v2/get_note_comments', '/api/v1/xiaohongshu/app_v2/get_note_sub_comments'],
    pagination: { endpoint: '/api/v1/xiaohongshu/app_v2/get_user_faved_notes', params: 'user_id/share_text/cursor', cursor: 'supported', note: '收藏列表 cursor 分页已登记；发帖列表分页参数未核对' }
  },
  lemon8: {
    discovery: ['/api/v1/lemon8/app/get_user_id'],
    profile: ['/api/v1/lemon8/app/fetch_user_profile'],
    body: ['/api/v1/lemon8/app/fetch_post_detail'],
    comments: ['/api/v1/lemon8/app/fetch_post_comment_list'],
    pagination: { endpoint: '/api/v1/lemon8/app/fetch_post_comment_list', params: 'offset', cursor: 'offset', note: '仅评论 offset 分页已登记；用户内容列表端点未登记' }
  },
  bilibili: {
    discovery: ['/api/v1/bilibili/web/fetch_get_user_id'],
    profile: ['/api/v1/bilibili/app/fetch_user_info'],
    list: ['/api/v1/bilibili/app/fetch_user_videos'],
    body: ['/api/v1/bilibili/app/fetch_one_video'],
    comments: ['/api/v1/bilibili/web/fetch_video_comments', '/api/v1/bilibili/web/fetch_comment_reply'],
    pagination: { endpoint: '/api/v1/bilibili/app/fetch_user_videos', params: 'page/ps', cursor: 'offset' }
  },
  kuaishou: {
    discovery: ['/api/v1/kuaishou/web/fetch_get_user_id'],
    profile: ['/api/v1/kuaishou/app/fetch_one_user_v2'],
    list: ['/api/v1/kuaishou/app/fetch_user_post_v2'],
    body: ['/api/v1/kuaishou/app/fetch_one_video'],
    comments: ['/api/v1/kuaishou/app/fetch_video_comment', '/api/v1/kuaishou/app/fetch_video_sub_comments'],
    pagination: { endpoint: '/api/v1/kuaishou/app/fetch_user_hot_post', params: 'pcursor', cursor: 'supported', note: 'pcursor 游标已登记' }
  },
  pipixia: {
    discovery: ['/api/v1/pipixia/app/fetch_user_info'],
    profile: ['/api/v1/pipixia/app/fetch_user_info'],
    list: ['/api/v1/pipixia/app/fetch_user_post_list'],
    body: ['/api/v1/pipixia/app/fetch_post_detail'],
    comments: ['/api/v1/pipixia/app/fetch_post_comment_list'],
    pagination: { endpoint: '/api/v1/pipixia/app/fetch_user_post_list', params: 'cursor/feed_count', cursor: 'supported' }
  },
  weibo: {
    discovery: ['/api/v1/weibo/app/fetch_user_info'],
    profile: ['/api/v1/weibo/app/fetch_user_info_detail'],
    list: ['/api/v1/weibo/web_v2/fetch_user_posts'],
    body: ['/api/v1/weibo/web_v2/fetch_post_detail'],
    comments: ['/api/v1/weibo/web_v2/fetch_post_comments', '/api/v1/weibo/app/fetch_status_comments'],
    media: ['/api/v1/weibo/app/fetch_user_album'],
    pagination: { endpoint: '/api/v1/weibo/app/fetch_user_articles', params: 'uid/since_id', cursor: 'supported', note: 'since_id 游标已登记' }
  },
  'wechat-mp': {
    discovery: [{ path: '/api/v1/wechat_mp/v2/fetch_account_profile', method: 'POST', requestBody: 'FetchAccountRequest' }],
    profile: [{ path: '/api/v1/wechat_mp/v2/fetch_account_profile', method: 'POST', requestBody: 'FetchAccountRequest' }],
    list: [{ path: '/api/v1/wechat_mp/v2/fetch_account_articles', method: 'POST', requestBody: 'FetchAccountArticlesRequest' }],
    body: [{ path: '/api/v1/wechat_mp/v2/fetch_article_detail', method: 'POST', requestBody: 'FetchArticleDetailRequest' }],
    comments: [
      { path: '/api/v1/wechat_mp/v2/fetch_article_comments', method: 'POST', requestBody: 'FetchArticleCommentsRequest' },
      { path: '/api/v1/wechat_mp/v2/fetch_comment_replies', method: 'POST', requestBody: 'FetchCommentRepliesRequest' }
    ],
    pagination: {
      endpoint: '/api/v1/wechat_mp/v2/fetch_account_articles',
      method: 'POST',
      requestBody: 'FetchAccountArticlesRequest',
      params: 'offset/page_size',
      cursor: 'supported',
      note: 'FetchAccountArticlesRequest.offset 为翻页游标（base64，首页留空、下页传上一页 next_offset）；page_size 被微信忽略（实测 1 与 40 相同）'
    }
  },
  'wechat-channels': {
    discovery: [
      { path: '/api/v1/wechat_channels/v2/fetch_channel_info', method: 'POST', requestBody: 'FetchChannelInfoRequest' },
      { path: '/api/v1/wechat_channels/v2/fetch_user_profile', method: 'POST', requestBody: 'FetchUserProfileRequest' }
    ],
    profile: [{ path: '/api/v1/wechat_channels/v2/fetch_user_profile', method: 'POST', requestBody: 'FetchUserProfileRequest' }],
    list: [{ path: '/api/v1/wechat_channels/v2/fetch_user_videos', method: 'POST', requestBody: 'FetchUserVideosRequest' }],
    body: [{ path: '/api/v1/wechat_channels/v2/fetch_video_detail', method: 'POST', requestBody: 'FetchVideoDetailRequest' }],
    comments: [{ path: '/api/v1/wechat_channels/v2/fetch_video_comments', method: 'POST', requestBody: 'FetchVideoCommentsRequest' }]
  },
  toutiao: {
    discovery: ['/api/v1/toutiao/app/get_user_id', '/api/v1/toutiao/app/get_user_info'],
    profile: ['/api/v1/toutiao/app/get_user_info'],
    body: ['/api/v1/toutiao/app/get_article_info', '/api/v1/toutiao/app/get_video_info'],
    comments: ['/api/v1/toutiao/app/get_comments'],
    pagination: { endpoint: '/api/v1/toutiao/app/get_comments', params: 'group_id/offset', cursor: 'offset', note: '仅评论 offset 分页已登记；用户内容列表端点未登记' }
  },
  xigua: {
    discovery: ['/api/v1/xigua/app/v2/fetch_user_info'],
    profile: ['/api/v1/xigua/app/v2/fetch_user_info'],
    list: ['/api/v1/xigua/app/v2/fetch_user_post_list'],
    body: ['/api/v1/xigua/app/v2/fetch_one_video'],
    comments: ['/api/v1/xigua/app/v2/fetch_video_comment_list'],
    media: ['/api/v1/xigua/app/v2/fetch_one_video_play_url'],
    pagination: { endpoint: '/api/v1/xigua/app/v2/fetch_user_post_list', params: 'max_behot_time', cursor: 'supported' }
  },
  instagram: {
    discovery: ['/api/v1/instagram/v1/fetch_user_info_by_username'],
    profile: ['/api/v1/instagram/v1/fetch_user_info_by_username'],
    list: ['/api/v1/instagram/v1/fetch_user_posts'],
    comments: ['/api/v1/instagram/v1/fetch_post_comments_v2', '/api/v1/instagram/v1/fetch_comment_replies'],
    pagination: { endpoint: '/api/v1/instagram/v1/fetch_user_posts', params: 'max_id/count', cursor: 'supported' }
  },
  youtube: {
    discovery: ['/api/v1/youtube/web/get_channel_id', '/api/v1/youtube/web/search_channel'],
    profile: ['/api/v1/youtube/web/get_channel_info'],
    list: ['/api/v1/youtube/web_v2/get_channel_videos', '/api/v1/youtube/web_v2/get_channel_community_posts'],
    body: ['/api/v1/youtube/web_v2/get_video_info', '/api/v1/youtube/web_v2/get_post_detail'],
    comments: ['/api/v1/youtube/web_v2/get_video_comments', '/api/v1/youtube/web_v2/get_video_comment_replies'],
    media: ['/api/v1/youtube/web_v2/get_video_streams', '/api/v1/youtube/web_v2/get_video_captions'],
    pagination: { endpoint: '/api/v1/youtube/web_v2/get_post_comment_replies', params: 'continuation_token', cursor: 'supported', note: 'continuation_token 游标已登记；频道视频列表分页参数未核对' }
  },
  x: {
    discovery: ['/api/v1/twitter/web/fetch_user_profile'],
    profile: ['/api/v1/twitter/web/fetch_user_profile'],
    list: ['/api/v1/twitter/web/fetch_user_post_tweet'],
    comments: ['/api/v1/twitter/web/fetch_post_comments', '/api/v1/twitter/web/fetch_latest_post_comments'],
    pagination: { endpoint: '/api/v1/twitter/web/fetch_user_post_tweet', params: 'cursor', cursor: 'supported' }
  },
  threads: {
    discovery: ['/api/v1/threads/web/fetch_user_info', '/api/v1/threads/web/search_profiles'],
    profile: ['/api/v1/threads/web/fetch_user_info'],
    list: ['/api/v1/threads/web/fetch_user_posts'],
    body: ['/api/v1/threads/web/fetch_post_detail'],
    comments: ['/api/v1/threads/web/fetch_post_comments'],
    pagination: { endpoint: '/api/v1/threads/web/fetch_user_posts', params: 'user_id/end_cursor', cursor: 'invalid', note: '官方描述：无分页，end_cursor 不生效；无效游标不表示列表读完' }
  },
  reddit: {
    discovery: ['/api/v1/reddit/app/fetch_user_profile'],
    profile: ['/api/v1/reddit/app/fetch_user_profile'],
    list: ['/api/v1/reddit/app/fetch_user_posts', '/api/v1/reddit/app/fetch_user_comments'],
    body: ['/api/v1/reddit/app/fetch_post_details'],
    comments: ['/api/v1/reddit/app/fetch_post_comments', '/api/v1/reddit/app/fetch_comment_replies'],
    pagination: {
      endpoint: '/api/v1/reddit/app/fetch_user_comments',
      method: 'GET',
      params: 'sort/after',
      cursor: 'supported',
      sortOptions: ['NEW', 'TOP', 'HOT', 'CONTROVERSIAL'],
      dateRange: 'unsupported',
      note: 'TikHub 端点仅有 sort（NEW/TOP/HOT/CONTROVERSIAL）与 after 游标，无日期范围参数；不跨路线照搬官方 after/before 语义（docs/platforms/reddit-routes.md）'
    }
  },
  linkedin: {
    discovery: ['/api/v1/linkedin/web_v2/get_user_profile'],
    profile: ['/api/v1/linkedin/web_v2/get_user_profile'],
    list: ['/api/v1/linkedin/web_v2/get_user_posts'],
    body: ['/api/v1/linkedin/web_v2/get_post_detail'],
    comments: ['/api/v1/linkedin/web_v2/get_post_comments'],
    pagination: { endpoint: '/api/v1/linkedin/web_v2/get_user_posts', params: 'start/pagination_token', cursor: 'supported' }
  },
  telegram: {
    discovery: ['/api/v1/telegram/web/fetch_channel_search', '/api/v1/telegram/web/fetch_channel_info'],
    profile: ['/api/v1/telegram/web/fetch_channel_info'],
    list: ['/api/v1/telegram/web/fetch_channel_posts'],
    body: ['/api/v1/telegram/web/fetch_post_detail'],
    comments: ['/api/v1/telegram/web/fetch_post_comments'],
    allNotes: 'TikHub 登记路径均为频道（channel）端点，不含个人账号读取。'
  },
  zhihu: {
    discovery: ['/api/v1/zhihu/web/fetch_user_info'],
    profile: ['/api/v1/zhihu/web/fetch_user_info'],
    list: ['/api/v1/zhihu/web/fetch_user_answers', '/api/v1/zhihu/web/fetch_user_articles'],
    body: ['/api/v1/zhihu/web/fetch_answer_detail'],
    comments: ['/api/v1/zhihu/web/fetch_comment_v5', '/api/v1/zhihu/web/fetch_pin_comments'],
    pagination: { endpoint: '/api/v1/zhihu/web/fetch_user_answers', params: 'offset/limit/sort_type', cursor: 'offset' }
  }
};

/**
 * Project-baseline evidence for the legacy probe/posts platforms. An
 * existence probe is discovery evidence only — never profile reading.
 */
const LEGACY_EV = {
  github: {
    discovery: { endpoints: ['https://api.github.com/users/{username}'], locator: 'project-legacy-registry:github' },
    profile: { endpoints: ['https://api.github.com/users/{username}'], locator: 'github-rest-docs:users' },
    list: {
      endpoints: ['https://api.github.com/users/{username}/repos'],
      locator: 'github-rest-docs:repos',
      note: '既有 GitHub 研究 adapter 真实读取本人拥有的仓库、仅首页（数量上限），不代表完整作品历史'
    },
    pagination: {
      endpoints: ['https://api.github.com/users/{username}/repos?page={page}&per_page={per_page}'],
      locator: 'github-rest-docs:repos-pagination',
      note: '分页参数有文档；当前 adapter 只读首页，分页未接入'
    }
  },
  gitlab: {
    discovery: { endpoints: ['https://gitlab.com/{username}'], locator: 'project-legacy-registry:gitlab' }
  },
  huggingface: {
    discovery: { endpoints: ['https://huggingface.co/{username}'], locator: 'project-legacy-registry:huggingface' }
  },
  bluesky: {
    discovery: { endpoints: ['https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor={username}'], locator: 'project-legacy-registry:bluesky' }
  },
  npm: {
    discovery: { endpoints: ['https://www.npmjs.com/~{username}'], locator: 'project-legacy-registry:npm' }
  },
  pypi: {
    discovery: { endpoints: ['https://pypi.org/user/{username}/'], locator: 'project-legacy-registry:pypi' }
  },
  hackernews: {
    discovery: { endpoints: ['https://news.ycombinator.com/user?id={username}'], locator: 'project-legacy-registry:hackernews' },
    list: {
      endpoints: ['https://hn.algolia.com/api/v1/search_by_date?tags=author_{username}&hitsPerPage=20&page={page}'],
      locator: 'project-legacy-registry:hackernews-posts',
      note: '帖子列表经既有帖子追踪读取器读取（页码分页，规则上限 2 页）'
    },
    pagination: {
      endpoints: ['https://hn.algolia.com/api/v1/search_by_date?tags=author_{username}&hitsPerPage=20&page={page}'],
      locator: 'project-legacy-registry:hackernews-posts',
      cursor: 'offset',
      note: '页码分页（page），规则上限 2 页'
    }
  },
  medium: {
    discovery: { endpoints: ['https://medium.com/@{username}'], locator: 'project-legacy-registry:medium' },
    list: {
      endpoints: ['https://medium.com/feed/@{username}'],
      locator: 'project-legacy-registry:medium-posts',
      note: 'RSS 经既有帖子追踪读取器读取；RSS 是唯一读取路径'
    },
    pagination: {
      endpoints: ['https://medium.com/feed/@{username}'],
      locator: 'project-legacy-registry:medium-posts',
      cursor: 'unsupported',
      note: 'RSS 单页，无分页'
    }
  },
  devto: {
    discovery: { endpoints: ['https://dev.to/api/users/by_username?url={username}'], locator: 'project-legacy-registry:devto' },
    list: {
      endpoints: ['https://dev.to/api/articles?username={username}&page={page}'],
      locator: 'project-legacy-registry:devto-posts',
      note: '文章列表经既有帖子追踪读取器读取（页码分页，规则上限 3 页）'
    },
    pagination: {
      endpoints: ['https://dev.to/api/articles?username={username}&page={page}'],
      locator: 'project-legacy-registry:devto-posts',
      cursor: 'offset',
      note: '页码分页（page），规则上限 3 页'
    }
  },
  reddit: {
    discovery: { endpoints: ['https://www.reddit.com/user/{username}/about.json'], locator: 'project-legacy-registry:reddit' },
    list: {
      endpoints: ['https://www.reddit.com/user/{username}/submitted.json?limit=25'],
      locator: 'project-legacy-registry:reddit-posts',
      note: '帖子列表经既有帖子追踪读取器读取（单页）；匿名入口常被 403/429 拦截'
    },
    comments: {
      endpoints: [],
      locator: 'project-reddit-routes.md:fetch_user_comments/fetch_post_comments',
      comments: { authorReplies: 'supported', parentChain: 'supported' },
      note: '本人评论与 include_comment_id 父链已文档核对（reddit-routes.md）；未接入、未 live 验证'
    }
  }
};

/* Integration matrix: only actual adapters/handlers are integrated. */
const PROBE_PLATFORMS = new Set(['github', 'gitlab', 'huggingface', 'bluesky', 'npm', 'pypi', 'hackernews', 'medium', 'devto', 'reddit']);
const LEGACY_LIST = new Set(['devto', 'hackernews', 'medium', 'reddit']);
const LEGACY_PAGE = new Set(['devto', 'hackernews']);

/* Canonical profile URL rules: explicit documented patterns only. */
const PROFILE_RULES = {
  github: ['https://github.com/{username}', 'GitHub REST users 资源返回的 htmlUrl 形式（github-rest-docs）'],
  gitlab: ['https://gitlab.com/{username}', '既有探测模板（project-legacy-registry:gitlab）'],
  huggingface: ['https://huggingface.co/{username}', '既有探测模板（project-legacy-registry:huggingface）'],
  medium: ['https://medium.com/@{username}', '既有探测模板（project-legacy-registry:medium）'],
  hackernews: ['https://news.ycombinator.com/user?id={username}', '既有探测模板（project-legacy-registry:hackernews）'],
  reddit: ['https://www.reddit.com/user/{username}', '既有探测模板（project-legacy-registry:reddit）'],
  npm: ['https://www.npmjs.com/~{username}', '既有探测模板（project-legacy-registry:npm）'],
  pypi: ['https://pypi.org/user/{username}/', '既有探测模板（project-legacy-registry:pypi）'],
  bluesky: ['https://bsky.app/profile/{username}', 'Bluesky 公开文档的 profile 页面形式（docs.bsky.app）'],
  mastodon: ['https://{instance}/@{username}', 'Mastodon 文档的实例内账号地址形式（joinmastodon.org）']
};

/* ------------------------------------------------------------------ */
/* Capability assembly                                                 */
/* ------------------------------------------------------------------ */

function tikhubEvidence(pid, dim) {
  const spec = TIKHUB[pid] ?? {};
  if (dim === 'pagination') {
    const pag = spec.pagination;
    return pag?.endpoint
      ? [{ path: pag.endpoint, method: pag.method ?? 'GET', requestBody: pag.requestBody ?? null }]
      : [];
  }
  return (Array.isArray(spec[dim]) ? spec[dim] : []).map((item) =>
    typeof item === 'string' ? { path: item, method: 'GET', requestBody: null } : item
  );
}

function legacyRef(pid, dim) {
  return LEGACY_EV[pid]?.[dim] ?? null;
}

function tikhubOperations(pid, dim) {
  return tikhubEvidence(pid, dim).map((item) => ({
    operationId: `${pid}-tikhub-${item.path.split('/').pop()}`,
    kind: pid === 'x' && (dim === 'profile' || dim === 'list') ? 'tikhub_tool' : 'tikhub_documented',
    method: item.method,
    endpoint: item.path,
    requestBody: item.requestBody ?? null,
    // Only the TikHub X tool is a real handler today; known-handle reads only.
    integrated: pid === 'x' && (dim === 'profile' || dim === 'list'),
    access: 'credentials_required',
    cost: tikhubCost(),
    sourceRefs: ['tikhub-openapi', 'tikhub-endpoint-pricing'],
    sourceLocator: `tikhub-path-index:${item.path}`,
    notes: pid === 'x' ? ['现有 TikHub X 工具按已知 handle 读取；不支持人物搜索。'] : []
  }));
}

function legacyOperation(pid, dim) {
  const legacy = legacyRef(pid, dim);
  if (!legacy || legacy.endpoints.length === 0) return null;
  const isGithubAdapter = pid === 'github' && (dim === 'profile' || dim === 'list' || dim === 'pagination');
  const integrated =
    dim === 'discovery' ? PROBE_PLATFORMS.has(pid)
    : dim === 'list' ? LEGACY_LIST.has(pid) || pid === 'github'
    : dim === 'pagination' ? LEGACY_PAGE.has(pid)
    : isGithubAdapter && dim !== 'pagination';
  return {
    operationId: `${pid}-${isGithubAdapter ? 'research-adapter' : 'legacy'}-${dim}`,
    kind: isGithubAdapter ? 'research_adapter' : (dim === 'discovery' ? 'legacy_probe' : 'legacy_posts'),
    method: 'GET',
    endpoint: legacy.endpoints[0],
    requestBody: null,
    integrated,
    access: 'public',
    cost: isGithubAdapter ? githubCost() : NO_PRICE,
    sourceRefs: isGithubAdapter && dim !== 'discovery' ? ['github-rest-docs'] : ['project-legacy-registry'],
    sourceLocator: legacy.locator,
    notes: legacy.note ? [legacy.note] : []
  };
}

function buildCapability(pid, dim) {
  const legacy = legacyRef(pid, dim);
  const tikhubPaths = tikhubEvidence(pid, dim);
  const ops = [
    ...(legacyOperation(pid, dim) ? [legacyOperation(pid, dim)] : []),
    ...tikhubOperations(pid, dim)
  ];
  const legacyEndpoints = legacy?.endpoints ?? [];
  const endpoints = [
    ...legacyEndpoints.map((endpoint) => `GET ${endpoint}`),
    ...tikhubPaths.map((item) => `${item.method} ${item.path}`)
  ];
  const sourceLocator =
    legacy?.locator ?? (tikhubPaths[0] ? `tikhub-path-index:${tikhubPaths[0].path}` : null);
  const documented = endpoints.length > 0 || sourceLocator !== null;

  // Source refs follow the actual evidence, never one route for everything.
  const sourceRefs = new Set();
  if (legacy || PROBE_PLATFORMS.has(pid)) sourceRefs.add('project-legacy-registry');
  if (pid === 'reddit' && (dim === 'comments' || dim === 'pagination')) sourceRefs.add('project-reddit-routes');
  if (pid === 'github' && ['profile', 'list', 'pagination'].includes(dim)) sourceRefs.add('github-rest-docs');
  if (tikhubPaths.length > 0) {
    sourceRefs.add('tikhub-openapi');
    sourceRefs.add('tikhub-endpoint-pricing');
  }
  if (sourceRefs.size === 0) sourceRefs.add('platform-official-docs');

  // Honest aggregates derive from the declared operations: the integrated
  // operation's conditions when one runs today, otherwise the shared
  // documented conditions (mixed/unknown stays unknown).
  const integratedOps = ops.filter((operation) => operation.integrated);
  let integration;
  let access;
  let cost;
  if (integratedOps.length > 0) {
    integration = 'integrated';
    access = integratedOps[0].access;
    cost = integratedOps[0].cost;
  } else {
    integration = 'not_integrated';
    const accesses = [...new Set(ops.map((operation) => operation.access))];
    const providers = [...new Set(ops.map((operation) => operation.cost.provider))];
    access = ops.length > 0 && accesses.length === 1 ? accesses[0] : 'unknown';
    cost = ops.length > 0 && providers.length === 1 ? ops[0].cost : NO_OPERATION_PRICE;
  }

  const notes = [];
  if (legacy?.note) notes.push(legacy.note);
  if (TIKHUB[pid]?.allNotes) notes.push(TIKHUB[pid].allNotes);

  const record = {
    dimension: dim,
    documentation: documented ? 'documented' : 'unknown',
    docUrls: tikhubPaths.length > 0
      ? [TIKHUB_OPENAPI_URL]
      : (pid === 'github' && ['profile', 'list', 'pagination'].includes(dim) ? ['https://docs.github.com/en/rest'] : []),
    endpoints,
    sourceLocator,
    integration,
    access,
    verification: 'documented_only',
    verificationRef: null,
    cost,
    sourceRefs: [...sourceRefs],
    operations: ops,
    notes
  };
  if (dim === 'comments') {
    record.comments = legacy?.comments ?? { authorReplies: 'unknown', parentChain: 'unknown' };
    // Thread reading is separate: no thread adapter and no own receipt exist.
    record.thread = {
      integration: 'not_integrated',
      access: 'unknown',
      verification: 'documented_only',
      maxDepth: null,
      verificationRef: null,
      notes: ['读线程是独立能力：无已接入线程读取器、无独立验收回执；评论回执/父链文档不构成线程证据。']
    };
  }
  if (dim === 'pagination') {
    const pag = legacy?.pagination ?? TIKHUB[pid]?.pagination ?? null;
    record.pagination = pag
      ? {
          cursor: pag.cursor ?? 'unknown',
          sortOptions: pag.sortOptions ?? null,
          dateRange: pag.dateRange ?? 'unknown'
        }
      : { cursor: 'unknown', sortOptions: null, dateRange: 'unknown' };
    if (pag?.params) notes.push(`分页参数：${pag.params}`);
    if (pag?.note) notes.push(pag.note);
  }
  return record;
}

function buildCapabilities(pid) {
  return DIMENSIONS.map((dim) => buildCapability(pid, dim));
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function route(routeId, kind, operation, adapterId, endpoint, requires, availability, reason, sourceRefs) {
  return { routeId, kind, operation, adapterId, endpoint, requires, availability, reason, sourceRefs };
}

function siteSearchRoute(pid) {
  return route(`${pid}-site-search`, 'site_search', 'search:site', null, null, ['provider_key'], 'not_integrated',
    '站点定向搜索未接入；GET-92 计划复用现有 Exa 工具，结果只作候选线索。', ['platform-official-docs']);
}

function probeRoute(pid) {
  return route(`${pid}-probe`, 'username_probe', 'probe:username', 'discovery-probe',
    LEGACY_EV[pid].discovery.endpoints[0], ['public_network'], 'integrated',
    '匿名探测规则已接入探测引擎，仅离线验证；结果不升格为 live_verified。', ['project-legacy-registry']);
}

function importRoute(pid) {
  return route(`${pid}-import`, 'import_report', 'import:report', 'report-import', null, [],
    'integrated', '仅接受 maigret / holehe 外部报告导入，保持 live_unverified。', ['project-legacy-registry']);
}

function wechatSearchRoute(id) {
  return route(id, 'wechat_search', 'search:wechat', null, null, ['login'], 'not_integrated',
    '微信搜一搜是辅助路线，不计为内容平台；未接入。', ['tikhub-openapi']);
}

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

function entry(platformId, name, cohort, {
  aliases = [], homepage, profileUrlRule = null, profileRuleBasis = null, instance = 'none',
  accountKinds = ['person'], inputKinds = ['username'], authorizations = [], conditions = [],
  notes = [], routes = []
}) {
  const entryNotes = [...notes];
  if (profileUrlRule && profileRuleBasis) entryNotes.push(`主页规则依据：${profileRuleBasis}`);
  if (!profileUrlRule) entryNotes.push('canonical 主页规则未冻结（无公开文档模式），保持 null。');
  return {
    platformId,
    name,
    cohort,
    aliases,
    homepage,
    profileUrlRule,
    instance,
    inputKinds,
    accountKinds,
    applicability: { authorizations, conditions },
    capabilities: buildCapabilities(platformId),
    routes,
    // Filled after the LEGACY table is initialized below.
    legacy: null,
    notes: entryNotes
  };
}

const entries = [];

function addTikHub(pid, name, homepage, options = {}) {
  const routes = [];
  if (pid === 'x') {
    // The implemented TikHub X tool (toolkit social_profile / social_posts)
    // reads a KNOWN handle's profile/posts; it is not people search.
    routes.push(route('x-tikhub-handle', 'username_probe', 'tikhub-x:fetch_user_profile', 'tikhub-x',
      'https://api.tikhub.io/api/v1/twitter/web/fetch_user_profile?screen_name={screen_name}',
      ['provider_key'], 'integrated',
      '现有 TikHub X 工具按已知 handle 读取资料/帖子（screen_name）；不做人物搜索。', ['tikhub-openapi']));
    routes.push(route('x-tikhub-search', 'platform_search', 'tikhub:twitter-search', null, null,
      ['provider_key'], 'not_integrated',
      'TikHub 目录含 Twitter 搜索类路径但本项目未接入；资料读取不支持人物搜索（GET-92 跟进）。', ['tikhub-openapi']));
  } else {
    routes.push(route(`${pid}-tikhub`, 'platform_search', 'tikhub:platform', null, null,
      ['provider_key'], 'not_integrated',
      '端点已在 TikHub 公开目录登记；本项目未接入该平台的 TikHub 工具（GET-91/92 跟进）。', ['tikhub-openapi']));
  }
  if (PROBE_PLATFORMS.has(pid)) routes.push(probeRoute(pid));
  if (pid === 'x' || pid === 'instagram' || pid === 'bilibili') routes.push(importRoute(pid));
  for (const extra of options.extraRoutes ?? []) routes.push(extra);
  routes.push(siteSearchRoute(pid));
  const rule = PROFILE_RULES[pid] ?? null;
  entries.push(entry(pid, name, 'tikhub', {
    homepage,
    aliases: options.aliases ?? [],
    profileUrlRule: rule?.[0] ?? null,
    profileRuleBasis: rule?.[1] ?? null,
    accountKinds: options.accountKinds ?? ['person'],
    notes: options.notes ?? [],
    routes
  }));
}

function addAlt(pid, name, homepage, options = {}) {
  const routes = [];
  if (PROBE_PLATFORMS.has(pid)) routes.push(probeRoute(pid));
  routes.push(siteSearchRoute(pid));
  const rule = PROFILE_RULES[pid] ?? null;
  entries.push(entry(pid, name, 'alternative', {
    homepage,
    aliases: options.aliases ?? [],
    profileUrlRule: rule?.[0] ?? null,
    profileRuleBasis: rule?.[1] ?? null,
    instance: options.instance ?? 'none',
    accountKinds: options.accountKinds ?? ['person'],
    authorizations: options.authorizations ?? [],
    conditions: options.conditions ?? [],
    notes: options.notes ?? [],
    routes
  }));
}

function addLegacyOnly(pid, name, homepage) {
  const rule = PROFILE_RULES[pid] ?? null;
  entries.push(entry(pid, name, 'legacy_only', {
    homepage,
    profileUrlRule: rule?.[0] ?? null,
    profileRuleBasis: rule?.[1] ?? null,
    notes: ['保留既有探测规则的兼容平台；不在 2026-09-30 目录的 50 平台清单内，仅防止旧投影丢失规则。'],
    routes: [probeRoute(pid), siteSearchRoute(pid)]
  }));
}

/* --- TikHub cohort (20) --- */

addTikHub('douyin', '抖音', 'https://www.douyin.com');
addTikHub('tiktok', 'TikTok', 'https://www.tiktok.com');
addTikHub('xiaohongshu', '小红书', 'https://www.xiaohongshu.com', { aliases: ['rednote'] });
addTikHub('lemon8', 'Lemon8', 'https://www.lemon8-app.com');
addTikHub('bilibili', '哔哩哔哩', 'https://www.bilibili.com', {
  accountKinds: ['person', 'channel'],
  notes: ['空间页以数字 UID 为主，用户名映射不确定；仅接受外部工具报告导入。']
});
addTikHub('kuaishou', '快手', 'https://www.kuaishou.com');
addTikHub('pipixia', '皮皮虾', 'https://www.pipix.com');
addTikHub('weibo', '微博', 'https://weibo.com', { aliases: ['sina-weibo'] });
addTikHub('wechat-mp', '微信公众号', 'https://mp.weixin.qq.com', {
  accountKinds: ['publication'],
  notes: ['微信公众号是出版账号，不等同自然人；归属裁决在后续任务。'],
  extraRoutes: [wechatSearchRoute('wechat-mp-search')]
});
addTikHub('wechat-channels', '微信视频号', 'https://channels.weixin.qq.com', {
  accountKinds: ['channel', 'person'],
  extraRoutes: [wechatSearchRoute('wechat-channels-search')]
});
addTikHub('toutiao', '今日头条', 'https://www.toutiao.com', { accountKinds: ['person', 'publication'] });
addTikHub('xigua', '西瓜视频', 'https://www.ixigua.com', { accountKinds: ['person', 'channel'] });
addTikHub('instagram', 'Instagram', 'https://www.instagram.com', {
  notes: [
    '登录墙与自动化限制导致未登录探测不可靠；仅接受外部工具报告导入。',
    '不绕过登录、验证码或访问控制。'
  ]
});
addTikHub('youtube', 'YouTube', 'https://www.youtube.com', { accountKinds: ['person', 'channel'] });
addTikHub('x', 'X (Twitter)', 'https://x.com', {
  aliases: ['twitter'],
  notes: ['未登录探测会被登录墙拦截；仅接受外部工具报告导入与已接入的 TikHub 工具。']
});
addTikHub('threads', 'Threads', 'https://www.threads.net', {
  notes: ['无效游标不表示列表读完（Threads invalid cursor）；fetch_user_posts 官方描述无分页。']
});
addTikHub('reddit', 'Reddit', 'https://www.reddit.com', {
  accountKinds: ['person'],
  notes: [
    '匿名入口常被 403/429 拦截；blocked 不改判为 not_found。',
    'TikHub 与官方 OAuth 两条路线未启用、未 live 验证；本登记不是运行时适配器。'
  ]
});
addTikHub('linkedin', 'LinkedIn', 'https://www.linkedin.com', { accountKinds: ['person', 'organization'] });
addTikHub('telegram', 'Telegram', 'https://telegram.org', {
  accountKinds: ['person', 'channel'],
  notes: ['频道（channel）与个人账号分开登记；TikHub 登记路径均为频道端点，频道不代表自然人。']
});
addTikHub('zhihu', '知乎', 'https://www.zhihu.com');

/* --- Alternative cohort (30) --- */

addAlt('facebook', 'Facebook', 'https://www.facebook.com', { accountKinds: ['person', 'organization'] });
addAlt('pinterest', 'Pinterest', 'https://www.pinterest.com');
addAlt('snapchat', 'Snapchat', 'https://www.snapchat.com');
addAlt('bluesky', 'Bluesky', 'https://bsky.app', {
  instance: 'optional',
  notes: ['handle 为域名形式（如 name.bsky.social）；纯用户名不保证命中。']
});
addAlt('mastodon', 'Mastodon / Fediverse', 'https://joinmastodon.org', {
  aliases: ['fediverse'],
  instance: 'required',
  conditions: ['实例限定平台：需要实例提示才能适用。'],
  notes: ['实例隔离保留；不同实例的同名账号不合并。']
});
addAlt('github', 'GitHub', 'https://github.com', {
  accountKinds: ['person', 'organization'],
  notes: ['旧 GitHub 研究 adapter 的验证不覆盖新的发现执行路径；仓库/作品研究仍走该 adapter。']
});
addAlt('gitlab', 'GitLab', 'https://gitlab.com', {
  instance: 'optional',
  accountKinds: ['person', 'organization'],
  notes: ['gitlab.com 之外存在自托管实例；实例可选。']
});
addAlt('hackernews', 'Hacker News', 'https://news.ycombinator.com', { aliases: ['hn'] });
addAlt('stackoverflow', 'Stack Overflow / Stack Exchange', 'https://stackoverflow.com', {
  aliases: ['stack-exchange'],
  accountKinds: ['person', 'organization']
});
addAlt('huggingface', 'Hugging Face', 'https://huggingface.co', { accountKinds: ['person', 'organization'] });
addAlt('medium', 'Medium', 'https://medium.com', { accountKinds: ['person', 'publication'] });
addAlt('substack', 'Substack', 'https://substack.com', { accountKinds: ['publication', 'person'] });
addAlt('twitch', 'Twitch', 'https://www.twitch.tv', { accountKinds: ['person', 'channel'] });
addAlt('steam', 'Steam', 'https://steamcommunity.com');
addAlt('naver', 'Naver', 'https://www.naver.com', { accountKinds: ['person', 'publication'] });
addAlt('vk', 'VK', 'https://vk.com', { accountKinds: ['person', 'organization'] });
addAlt('spotify', 'Spotify', 'https://open.spotify.com', { accountKinds: ['person', 'organization'] });
addAlt('soundcloud', 'SoundCloud', 'https://soundcloud.com');
addAlt('kick', 'Kick', 'https://kick.com', { accountKinds: ['person', 'channel'] });
addAlt('rumble', 'Rumble', 'https://rumble.com', { accountKinds: ['person', 'channel'] });
addAlt('truth-social', 'Truth Social', 'https://truthsocial.com', { aliases: ['truthsocial'] });
addAlt('linktree', 'Linktree', 'https://linktr.ee');
addAlt('quora', 'Quora', 'https://www.quora.com');
addAlt('douban', '豆瓣', 'https://www.douban.com');
addAlt('baidu-tieba', '百度贴吧', 'https://tieba.baidu.com');
addAlt('jike', '即刻', 'https://web.okjike.com');
addAlt('xiaoyuzhou', '小宇宙', 'https://www.xiaoyuzhoufm.com', { accountKinds: ['person', 'channel'] });
addAlt('whatsapp', 'WhatsApp', 'https://www.whatsapp.com', {
  authorizations: ['self', 'consent_obtained'],
  conditions: ['私密通信平台：仅限本人或已获授权研究。']
});
addAlt('line', 'LINE', 'https://line.me', {
  authorizations: ['self', 'consent_obtained'],
  conditions: ['私密通信平台：仅限本人或已获授权研究。']
});
addAlt('discord', 'Discord', 'https://discord.com', {
  accountKinds: ['person', 'organization'],
  conditions: ['公开服务器与私信边界未核对；不把私信内容当作公开材料。']
});

/* --- personal website (1) --- */

entries.push(entry('personal-website', '个人网站', 'personal_website', {
  homepage: 'https://{host}',
  inputKinds: ['homepage_url'],
  accountKinds: ['person'],
  notes: [
    '个人网站登记为原作/自链入口；域名与路径由输入提供，不固定。',
    '出版账号与自然人不合并；自链只产生候选，归属裁决在后续任务。'
  ],
  routes: [
    route('personal-website-selflink', 'selflink', 'selflink:extract', null, null, ['public_network'], 'not_integrated',
      '自链抽取待 GET-92；只从页面实际输出的可定位链接抽取，普通提及不当互链。', ['platform-official-docs']),
    siteSearchRoute('personal-website')
  ]
}));

/* --- legacy_only cohort (3): retained old probe rules --- */

addLegacyOnly('devto', 'DEV Community', 'https://dev.to');
addLegacyOnly('npm', 'npm', 'https://www.npmjs.com');
addLegacyOnly('pypi', 'PyPI', 'https://pypi.org');

/* ------------------------------------------------------------------ */
/* Legacy probe rules — verbatim from src/server/platforms/registry.ts  */
/* ------------------------------------------------------------------ */

function probeStatus(transport, urlTemplate, found = [200], notFound = [404], blocked = [403, 429]) {
  return {
    kind: 'http_status',
    method: 'GET',
    urlTemplate,
    foundStatuses: found,
    notFoundStatuses: notFound,
    blockedStatuses: blocked,
    foundMarker: null,
    notFoundMarker: null,
    transport
  };
}

const NO_POSTS = {
  kind: 'none',
  urlTemplate: '',
  maxPages: 0,
  itemsPath: '',
  fields: { id: null, url: null, title: null, publishedAt: null, excerpt: null }
};

function legacy(category, homepage, probe, posts, rateLimitPerMinute, verification, verificationNote, notes) {
  return {
    category,
    subjectKinds: ['username'],
    homepage,
    probe,
    posts,
    rateLimitPerMinute,
    verification,
    verificationNote,
    notes
  };
}

const LEGACY = {
  github: legacy(
    'code', 'https://github.com',
    probeStatus('api_http', 'https://api.github.com/users/{username}', [200], [404], [401, 403, 429]),
    NO_POSTS, 20, 'live_verified',
    '端点语义（200 存在 / 404 不存在）已在既有 GitHub 研究 adapter 的真实请求中验收；探测引擎路径本身仅离线验证。',
    ['仓库/作品研究仍走 GitHub 研究 adapter；此处只回答账号是否存在。']
  ),
  devto: legacy(
    'writing', 'https://dev.to',
    probeStatus('api_http', 'https://dev.to/api/users/by_username?url={username}'),
    {
      kind: 'json_list',
      urlTemplate: 'https://dev.to/api/articles?username={username}&page={page}',
      maxPages: 3,
      itemsPath: '',
      fields: { id: 'id', url: 'url', title: 'title', publishedAt: 'published_at', excerpt: 'description' }
    },
    10, 'live_unverified', '按 DEV 公开 API 文档编写；未做 live 验证，命中语义待实测。',
    ['公开 API，无需密钥。']
  ),
  hackernews: legacy(
    'social', 'https://news.ycombinator.com',
    {
      kind: 'http_marker',
      method: 'GET',
      urlTemplate: 'https://news.ycombinator.com/user?id={username}',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [403, 429],
      foundMarker: 'submissions',
      notFoundMarker: 'No such user',
      transport: 'profile_http'
    },
    {
      kind: 'json_list',
      urlTemplate: 'https://hn.algolia.com/api/v1/search_by_date?tags=author_{username}&hitsPerPage=20&page={page}',
      maxPages: 2,
      itemsPath: 'hits',
      fields: { id: 'objectID', url: 'url', title: 'title', publishedAt: 'created_at', excerpt: 'story_text' }
    },
    10, 'live_unverified', '页面标记字符串按公开页面预期编写；标记不匹配一律降级为 unknown。',
    ['帖子追踪走 Algolia 公开搜索 API。']
  ),
  medium: legacy(
    'writing', 'https://medium.com',
    probeStatus('profile_http', 'https://medium.com/@{username}'),
    {
      kind: 'rss',
      urlTemplate: 'https://medium.com/feed/@{username}',
      maxPages: 1,
      itemsPath: '',
      fields: { id: 'guid', url: 'link', title: 'title', publishedAt: 'pubDate', excerpt: 'description' }
    },
    6, 'live_unverified', '主页与 RSS 端点按公开约定编写；未做 live 验证。',
    ['RSS 是唯一读取路径；不抓取正文全文。']
  ),
  reddit: legacy(
    'social', 'https://www.reddit.com',
    probeStatus('api_http', 'https://www.reddit.com/user/{username}/about.json', [200], [404], [401, 403, 429]),
    {
      kind: 'json_list',
      urlTemplate: 'https://www.reddit.com/user/{username}/submitted.json?limit=25',
      maxPages: 1,
      itemsPath: 'data.children',
      fields: { id: 'data.id', url: 'data.url', title: 'data.title', publishedAt: 'data.created_utc', excerpt: 'data.selftext' }
    },
    4, 'live_unverified', '未登录请求经常被 403/429 拦截；预期大量 blocked，不做存在性断言。',
    ['被拦截即如实记录 blocked，不改判为 not_found。']
  ),
  npm: legacy(
    'code', 'https://www.npmjs.com',
    probeStatus('profile_http', 'https://www.npmjs.com/~{username}'),
    NO_POSTS, 10, 'live_unverified', '按公开站点约定编写；未做 live 验证。', []
  ),
  pypi: legacy(
    'code', 'https://pypi.org',
    probeStatus('profile_http', 'https://pypi.org/user/{username}/'),
    NO_POSTS, 10, 'live_unverified', '按公开站点约定编写；未做 live 验证。', []
  ),
  huggingface: legacy(
    'code', 'https://huggingface.co',
    probeStatus('profile_http', 'https://huggingface.co/{username}'),
    NO_POSTS, 10, 'live_unverified', '按公开站点约定编写；未做 live 验证。', []
  ),
  gitlab: legacy(
    'code', 'https://gitlab.com',
    probeStatus('profile_http', 'https://gitlab.com/{username}'),
    NO_POSTS, 10, 'live_unverified', '未做 live 验证；未知跳转/重定向一律降级为 unknown。', []
  ),
  bluesky: legacy(
    'social', 'https://bsky.app',
    probeStatus('api_http', 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor={username}', [200], [400], [401, 403, 429]),
    NO_POSTS, 10, 'live_unverified', '按公开 AppView API 编写；handle 需要完整域名形式，纯用户名不保证命中。',
    ['用户需提供完整 handle（如 name.bsky.social）。']
  ),
  x: legacy(
    'social', 'https://x.com', null, NO_POSTS, 0, 'live_unverified',
    '未登录探测会被登录墙拦截，无法区分存在/不存在；仅接受外部工具报告导入。',
    ['导入来源为 maigret 等外部报告；结论保持 live_unverified。']
  ),
  instagram: legacy(
    'social', 'https://www.instagram.com', null, NO_POSTS, 0, 'live_unverified',
    '登录墙与自动化限制导致未登录探测不可靠；仅接受外部工具报告导入。',
    ['不绕过登录、验证码或访问控制。']
  ),
  bilibili: legacy(
    'social', 'https://space.bilibili.com', null, NO_POSTS, 0, 'live_unverified',
    '空间页以数字 UID 为主，用户名映射不确定；仅接受外部工具报告导入。', []
  )
};

// Attach the verbatim legacy rules to their entries (the table above is
// defined after the entry assembly for readability).
for (const item of entries) {
  item.legacy = LEGACY[item.platformId] ?? null;
}

/* ------------------------------------------------------------------ */
/* Emit catalog.json + manifest.json                                   */
/* ------------------------------------------------------------------ */

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

const content = {
  schemaVersion: SCHEMA,
  registryVersion: VERSION,
  generatedAt: GENERATED,
  sources: SOURCES,
  entries
};

const contentHash = `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(content)), 'utf8').digest('hex')}`;
const catalog = { ...content, contentHash };

mkdirSync(OUT, { recursive: true });
const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
writeFileSync(path.join(OUT, 'catalog.json'), catalogBytes);
const fileHash = createHash('sha256').update(catalogBytes).digest('hex');

const manifest = {
  schemaVersion: MANIFEST_SCHEMA,
  registryVersion: VERSION,
  files: [{ path: 'catalog.json', sha256: fileHash }],
  counts: {
    platforms: entries.length,
    tikhub: entries.filter((e) => e.cohort === 'tikhub').length,
    alternative: entries.filter((e) => e.cohort === 'alternative').length,
    personal_website: entries.filter((e) => e.cohort === 'personal_website').length,
    legacy_only: entries.filter((e) => e.cohort === 'legacy_only').length,
    routes: entries.reduce((total, e) => total + e.routes.length, 0),
    capabilityRecords: entries.reduce((total, e) => total + e.capabilities.length, 0),
    sources: SOURCES.length
  },
  notes: [
    'counts 为本目录的独立机器核对入口；平台数量与路线数量分开计数。',
    'maigret / whatsmyname 只冻结来源元数据（版本/hash/许可），未导入、无导入计数；GET-91 才填写 raw/loaded/excluded。'
  ]
};
writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`contentHash: ${contentHash}`);
console.log(`catalog.json sha256: ${fileHash}`);
console.log(`entries: ${entries.length}, routes: ${manifest.counts.routes}, capability records: ${manifest.counts.capabilityRecords}`);
