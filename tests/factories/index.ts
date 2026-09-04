// Test-database row builders. Every value that must be unique comes from the
// module-level counter in ./seq.ts, never from a random source.
//
// All of them insert through `@/lib/db`, so a test file that imports this
// transitively imports the Prisma singleton and therefore depends on
// tests/setup/api.ts having loaded .env.test first. That is arranged by the
// `api` project's setupFiles.

export { nextSeq, uniqueName } from './seq';

export { createUser, createExpiredUser, createSubscribedUser } from './user';
export type { CreateUserInput } from './user';

export { createWorkspace, addWorkspaceMember, createInvitation } from './workspace';
export type {
  CreateWorkspaceInput,
  AddWorkspaceMemberInput,
  CreateInvitationInput,
} from './workspace';

export { createProject, addProjectMember, createCommentTag } from './project';
export type { CreateProjectInput, AddProjectMemberInput, CreateCommentTagInput } from './project';

export { createFolder } from './folder';
export type { CreateFolderInput } from './folder';

export { createVideo, createVersion, createVideoAsset, createUploadReservation } from './video';
export type {
  CreateVideoInput,
  CreateVersionInput,
  CreateVideoAssetInput,
  CreateUploadReservationInput,
} from './video';

export { createComment } from './comment';
export type { CreateCommentInput } from './comment';

export { createReadyTranscript } from './transcript';
export type { CreateTranscriptInput } from './transcript';

export { createShareLink } from './share';
export type { CreateShareLinkInput } from './share';

export { createApprovalRequest } from './approval';
export type { CreateApprovalRequestInput } from './approval';

export { createEditorialBrief, createRoughCut, createRoughCutProfile } from './rough-cut';
export type {
  CreateEditorialBriefInput,
  CreateRoughCutInput,
  CreateRoughCutProfileInput,
} from './rough-cut';

export { seedProject, seedVersion } from './scenario';
export type { ProjectScenario, VersionScenario } from './scenario';
