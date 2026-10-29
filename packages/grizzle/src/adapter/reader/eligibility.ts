import { Result } from "effect"
import { toResult } from "#adapter/engine.ts"
import { requireGet } from "#compiler/analysis/logical/get.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"

/**
 * get eligibility at run time.
 *
 * get reads "any query proved at most one row per parameter binding" as an Option. TypeScript checks it from the
 * evidence it can compute (types/evidence), and a query TypeScript did not check, from a JavaScript caller or rebuilt
 * from a Description, is refused here: its root's normative cardinality must be atMostOne or one
 * (analysis/logical/get.ts requireGet). The proof is the template's analyzed DAG (QueryTemplate.analyzed), computed
 * once at compile, under the schema's laws and the context the read runs in.
 *
 * Whether `template`'s query is proved at most one row per parameter binding in the context it was compiled for.
 */
export const getEligibility = (template: QueryTemplate): Result.Result<void, CompileError> =>
	Result.map(
		toResult(requireGet(template.analyzed.roots[0], SourceLoc("reader.get", []))),
		() => undefined
	)
