export type AgentKind = 'REVIEW' | 'EDIT';

export type AgentContextComment = {
  id: string;
  timestamp: number;
  timestampEnd: number | null;
  content: string | null;
  isResolved: boolean;
  source: 'HUMAN' | 'AGENT';
};

export type AgentContextCue = {
  start: number;
  end: number;
  text: string;
};

export type AgentContext = {
  version: {
    id: string;
    title: string;
    duration: number | null;
    projectName: string;
    frameRateNum: number | null;
    frameRateDen: number | null;
  };
  transcript: { language: string; segments: AgentContextCue[] } | null;
  comments: AgentContextComment[];
  brief: string | null;
};

export type ReviewFindingSeverity = 'info' | 'warning' | 'blocker';

export type ReviewFindingTagName = 'Feedback' | 'Technical' | 'Creative' | 'Approved' | 'Urgent';

export type ReviewFinding = {
  timestamp: number;
  timestampEnd?: number | null;
  body: string;
  tagName?: ReviewFindingTagName;
  severity?: ReviewFindingSeverity;
};

export type ReviewFindings = {
  findings: ReviewFinding[];
  summary?: string;
};

export type EditPlanOperation =
  | { op: 'cut'; start: number; end: number }
  | { op: 'keep'; start: number; end: number };

export type EditPlan = {
  version: 1;
  operations: EditPlanOperation[];
};

export interface AgentModel {
  name: string;
  generateFindings(input: { system: string; context: AgentContext }): Promise<ReviewFindings>;
  generateEditPlan(input: { system: string; context: AgentContext }): Promise<EditPlan>;
}
