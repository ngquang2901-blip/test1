export type ProjectWorkflow = { workflowId: string; title: string; createdMs: number; primaryMediaId: string; batchId: string | null };
export type ProjectMedia = {
  mediaId: string; workflowId: string; kind: 'image' | 'video' | 'upload'; prompt: string | null; batchId: string | null;
  createdMs: number; refIds: string[]; seed: number | null; model: string | null; status: number | null;
};
export type Project = { projectId: string; workflows: Map<string, ProjectWorkflow>; media: ProjectMedia[] };
export function parseProject(payload: unknown, projectId: string): Project;
export type ReconcileAttempt = { prompt: string; kind: 'image' | 'video'; clickMs: number; batchId?: string };
export type ReconcileResult = {
  verdict: 'found' | 'not_found' | 'ambiguous'; mediaIds: string[]; batchId: string | null; source?: 'Zzl0ze'; evidence: Record<string, unknown>;
};
export function reconcile(project: Project, attempt: ReconcileAttempt, opts?: { owned?: Set<string>; windowMs?: number; skewMs?: number }): ReconcileResult;
