import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { ConservativeDelivery } from "#compiler/lower/conservative/deliver.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import type {
	ConservativeInput,
	ConservativeOptions,
	ConservativeProgram
} from "#compiler/lower/conservative/types.ts"

/**
 * The statements that deliver the result of `input.root`. Every refusal is a CompileError: UnsupportedOperation for a
 * construct the baseline does not lower, MalformedDescription for an IR that breaks its
 * own scope or shape promises.
 *
 * The conservative lowering: the oracle baseline every optimization is compared against.
 *
 * It turns a query DAG into the statements that deliver its result. It deduplicates at every set boundary and uses no
 * rewrite certificate and no evidence: no key, no containment, no cardinality claim lets it drop a DISTINCT, a join or
 * a deduplicated input. It is correct by construction rather than fast:
 *
 * - Base, Closed and InputSet are a deduplicated table scan, typed VALUES and the input's arrays;
 * - MatchRegion is a join of its occurrences' sources with every binding equality in WHERE, LATERAL where a source
 *   reads the region's variables;
 * - Filter, ProjectSet and SemiJoin/AntiJoin are SELECT DISTINCT with WHERE, the projected expressions, and
 *   EXISTS (SELECT 1 ...) and NOT EXISTS;
 * - Union, Intersect and Difference are UNION, INTERSECT and EXCEPT;
 * - Group folds SELECT DISTINCT of the complete bound tuple, with a constant private group key when aggregate-only;
 * - Take is ORDER BY LIMIT over its deduplicated input, LATERAL when correlated;
 * - Recursive is WITH RECURSIVE ... UNION with every column cast to the state type;
 * - Attach is a pipelined statement keyed by the delivered parent keys, and a heterogeneous union delivered to the host
 *   is one statement per heading group (deliver.ts);
 * - a node its statement reads more than once is one MATERIALIZED CTE, read at every use (dispatch.ts), so a statement
 *   grows with the DAG it lowers, never with the paths through it.
 *
 * Every statement leaves through sql/emit.
 */
export const lowerConservative = (
	input: ConservativeInput,
	options: ConservativeOptions
): Result.Result<ConservativeProgram, CompileError> =>
	catchRefusal(() => {
		const cx = new LowerContext(input.dag, options, dispatchNode)
		return new ConservativeDelivery(cx).program(input.root)
	})
