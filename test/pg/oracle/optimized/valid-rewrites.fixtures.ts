import { Array as Arr } from "effect"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { Select, SelectCore } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { validRewriteRules } from "#test/pg/oracle/optimized/suite.ts"
import type { DifferentialOutcome } from "#test/pg/oracle/optimized/support.ts"
import { programAsts } from "#test/support/compile.ts"

/** The certificate of the valid transformation V1: a DISTINCT elided where the projection retains a primary key. */
export const retainedPrimaryKey = validRewriteRules[0]

/** How many SELECT cores of some statements' ASTs carry a DISTINCT, read through the transform's typed hooks. */
const distinctCores = (statements: ReadonlyArray<{ readonly ast: Select }>): number => {
	const cores: Array<SelectCore> = []
	for (const s of statements) {
		transformStatement(s.ast, {
			...identityHooks,
			core: (core) => {
				cores.push(core)
				return core
			}
		})
	}
	return Arr.filter(cores, (core) => core.distinct !== false).length
}

/** Whether the optimized program's statements hold fewer DISTINCT cores than the conservative lowering's. */
export const fewerDistinctCores = (o: DifferentialOutcome): boolean =>
	distinctCores(Arr.map(programAsts(o.optimizedProgram), (ast) => ({ ast }))) <
	distinctCores(flight(o.conservativeProgram.roots))
