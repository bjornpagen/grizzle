import { contextAdmits, evidenceContexts, type TemplateContext } from "#compiler/ir/evidence.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"

/**
 * The artifact an execution runs: the optimized one, or the conservative one when the template was compiled for a
 * context whose evidence the execution context does not admit.
 */
export type ArtifactSelection =
	| { readonly artifact: "optimized"; readonly statements: ReadonlyArray<StatementSpec> }
	| { readonly artifact: "conservative"; readonly statements: ReadonlyArray<StatementSpec> }

/**
 * Whether every evidence context the compiled context admits is admitted by the execution context: a template's
 * proofs may rest on any of them.
 */
export const contextServes = (compiled: TemplateContext, execution: TemplateContext): boolean =>
	evidenceContexts.every((e) => !contextAdmits(compiled, e) || contextAdmits(execution, e))

/**
 * Evidence-context selection: which of a template's two artifacts an execution runs.
 *
 * A template is compiled for one execution context:
 *
 * - `snapshot`: Db reads, one READ ONLY snapshot for a multi-statement read. Every committed deferred law holds in it,
 *   so lawful committed-snapshot evidence is admitted.
 * - `transaction`: reads inside a write transaction, as read-backs are, where a deferred law may be
 *   temporarily false until COMMIT, so only descriptor, immediate and query-local evidence is admitted.
 *
 * "A compiled artifact states the minimum context it requires; executing it in a weaker context chooses an
 * already-compiled conservative artifact or fails admission. It must never quietly retain an invalid join-elimination
 * proof". So:
 *
 * - a template compiled for `snapshot` runs its conservative artifact in a `transaction` execution, whatever its
 *   certificates happen to need: its proofs were made under the wider context, and the only context-safe reuse is the
 *   artifact that rests on none. A caller that wants the optimized form compiles again for `transaction`;
 * - a template compiled for `transaction` runs its optimized artifact in either context, since every context admits
 *   what a transaction admits.
 */
export const selectArtifact = (
	template: Pick<QueryTemplate, "context" | "optimized" | "conservative">,
	execution: TemplateContext
): ArtifactSelection =>
	contextServes(template.context, execution)
		? { artifact: "optimized", statements: template.optimized }
		: { artifact: "conservative", statements: template.conservative }
