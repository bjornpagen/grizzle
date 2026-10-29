import { omitSourceLocs } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import { ProgramFingerprint, type SchemaFingerprint } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"

/**
 * The semantic fingerprint of the ordered query a page cursor names (adapter/page/template.ts), so a cursor of one
 * ordered query never pages another.
 *
 * SHA-256, under the domain `workload-program`, over the query's canonical Description as a program (its kind and its
 * Description with every import and constant; source locations excluded) and the fingerprint of the schema it is
 * compiled on. It does not depend on the query's name, on the evidence context a template is compiled for, on the
 * connection identity, or on any parameter value: one query has one fingerprint wherever it runs.
 */
export const pageQueryFingerprint = (
	query: QueryDesc,
	schema: SchemaFingerprint
): Result.Result<ProgramFingerprint, CompileError> =>
	Result.map(
		digest(
			"workload-program",
			{ program: { kind: "query", query }, schema },
			{ omit: omitSourceLocs }
		),
		ProgramFingerprint
	)
