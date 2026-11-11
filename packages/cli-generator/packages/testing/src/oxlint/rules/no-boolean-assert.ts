import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import {
	assertionOf,
	type Assertion,
	EQUALITIES,
	expectMessageOf,
	isCallTo,
	isLiteralOf,
	valueOf
} from "#oxlint/syntax.ts"

/** The assertions that check a value is true or false and say nothing else when it is not. */
const TRUTHS: ReadonlyArray<string> = [
	"assert",
	"assertFalse",
	"assertTrue",
	"isFalse",
	"isTrue",
	"ok",
	"toBeFalsy",
	"toBeTruthy"
]

/** The predicates a narrower assertion states with its own failure message. */
const PREDICATES: ReadonlyArray<string> = [
	"Equal.equals",
	"Exit.isFailure",
	"Exit.isSuccess",
	"Option.isNone",
	"Option.isSome",
	"Predicate.isTagged",
	"Result.isFailure",
	"Result.isSuccess"
]

const COMPARISONS: ReadonlyArray<string> = ["===", "!==", "==", "!="]

/** A predicate or a comparison, negated or not, called data-first or data-last, or named by a `const`. */
const isNarrowable = (context: Context, node: AnyNode): boolean => {
	const value = valueOf(context, node)
	if (value.type === "UnaryExpression") {
		return value.operator === "!" && isNarrowable(context, value.argument)
	}
	if (value.type === "BinaryExpression") {
		return Arr.contains(COMPARISONS, value.operator)
	}
	return (
		isCallTo(context, value, PREDICATES) ||
		(value.type === "CallExpression" && isCallTo(context, value.callee, PREDICATES))
	)
}

/** The value a boolean assertion checks: its argument, or the side an equality compares with `true` or `false`. */
const assertedOf = ({ name, subjects }: Assertion): Option.Option<AnyNode> => {
	if (Arr.contains(TRUTHS, name)) {
		return Arr.head(subjects)
	}
	if (!Arr.contains(EQUALITIES, name)) {
		return Option.none()
	}
	const [actual, expected] = subjects
	if (actual === undefined || expected === undefined) {
		return Option.none()
	}
	if (isLiteralOf(expected, ["boolean"])) {
		return Option.some(actual)
	}
	return isLiteralOf(actual, ["boolean"]) ? Option.some(expected) : Option.none()
}

/**
 * Whether an assertion states its fact in a message: an argument past the values it checks (one for a truth assertion,
 * two for an equality), or the message of an `expect(actual, message)` chain. A computed property with no narrower
 * matcher explains its failure that way.
 */
const carriesMessage = (context: Context, node: AnyNode, assertion: Assertion): boolean =>
	assertion.subjects.length > (Arr.contains(TRUTHS, assertion.name) ? 1 : 2) ||
	Option.isSome(expectMessageOf(context, node))

/**
 * A boolean assertion over a fact a narrower assertion states: `assertTrue(Option.isSome(x))`,
 * `expect(Exit.isSuccess(exit)).toBe(true)`, `assert(a === b)`, with no message. Its failure says only that something
 * was false; the narrower assertion's failure shows the value, and a message states the fact.
 */
export const noBooleanAssert = refusal(
	"booleanAssert",
	"A boolean assertion fails with “expected true” and nothing else. Assert the narrower fact so a failure explains itself: assertExitSuccess or assertExitFailure for an Exit, assertSome or assertNone for an Option, assertSuccess or assertFailure for a Result, strictEqual on _tag for a tagged value, and strictEqual, deepStrictEqual or assertEquals for an equality; or give the assertion a message that states the fact.",
	(context, refuse) => ({
		CallExpression: (node) => {
			const narrowable = Option.exists(assertionOf(context, node), (assertion) =>
				Option.exists(
					assertedOf(assertion),
					(asserted) => isNarrowable(context, asserted) && !carriesMessage(context, node, assertion)
				)
			)
			if (narrowable) {
				refuse(node)
			}
		}
	})
)
