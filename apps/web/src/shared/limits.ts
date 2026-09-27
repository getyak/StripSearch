/** Central bounds for request, provider and job limits. */

export const LIMITS = {
  questionMin: 2,
  questionMax: 500,
  seedUrlMax: 2048,
  displayNameMax: 60,
  emailMax: 254,
  passwordMin: 8,
  passwordMax: 128,

  /** JSON bodies for application routes. */
  jsonBodyBytes: 32 * 1024,
  /** Raw bodies for the Better Auth handler, checked before it reads the stream. */
  authBodyBytes: 8 * 1024,

  /** Provider network bounds. */
  providerTimeoutMs: 15_000,
  providerMaxBytes: 512 * 1024,
  githubReposPerPage: 30,
  githubMaxWorks: 8,
  exaResults: 6,
  exaExcerptMax: 1200,
  exaAnswerMax: 4000,

  /** Job scheduling. */
  globalConcurrentJobs: 3,
  userConcurrentJobs: 1,
  maxRunsPerUser: 200,
  startRateWindowMs: 60_000,
  startRateMax: 10,

  ssePollIntervalMs: 400,
  sseHeartbeatMs: 15_000,

  /** Annotation workbench bounds. */
  reviewTitleMax: 120,
  reviewAsOfMax: 40,
  reviewSourceTitleMax: 160,
  reviewSourceTextMax: 1200,
  reviewSourceLocatorMax: 160,
  reviewMaxSources: 12,
  reviewCandidateOriginMax: 80,
  reviewCandidateModelMax: 80,
  reviewCandidateNotesMax: 200,
  reviewMaxClaimsPerCandidate: 12,
  reviewClaimTextMax: 600,
  reviewNoteMax: 600,
  reviewRationaleMax: 1200,
  reviewReferenceAnswerMax: 2000,
  reviewMustIncludeMax: 1200,
  reviewMustAvoidMax: 1200,
  reviewMaxReasonTags: 6,
  reviewMaxCasesPerUser: 200,
  reviewQueueLimit: 200,

  /** Candidate-free research task library (evaluation specs, never run here). */
  researchTaskExternalIdMax: 120,
  researchTaskDatasetVersionMax: 60,
  researchTaskPromptMax: 2000,
  researchTaskSeedUrlsMax: 8,
  researchTaskChecksMax: 12,
  researchTaskCheckIdMax: 64,
  researchTaskFocusMax: 200,
  researchTaskLookForMax: 1000,
  researchTaskObservationMax: 1000,
  researchTaskFailureMax: 1000,
  researchTaskMaxPerUser: 50,

  /** Platform discovery and post tracking. */
  discoverySubjectMax: 254,
  discoverySeedUrlMax: 2048,
  discoveryImportBytes: 256 * 1024,
  discoveryImportReportMax: 4000,
  discoveryCorrectionsMax: 50,
  discoveryNoteMax: 600,
  discoveryCounterevidenceMax: 600,
  discoveryMaxTasksPerUser: 200,
  discoveryQueueLimit: 200
} as const;

export const SESSION_EXPIRES_SECONDS = 60 * 60 * 24 * 7;
