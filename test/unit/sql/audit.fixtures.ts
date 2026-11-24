/** What the properties of audit.test.ts read: its spaces, models and helpers. */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { keyOf, type Reached, type Situations } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Order, String as Str } from "effect"
import { decode, encode, everyProperty, noRevivers } from "#compiler/core/canonical.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"
import type { CteBody, Expr, SqlStatement, TypeRef } from "#compiler/sql/ast.ts"
import { builtinType } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printStatement, printType } from "#compiler/sql/print.ts"
import {
	identityHooks,
	statementParams,
	transformExpr,
	transformStatement
} from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { type ShapeFeature, shapeFeatures, shapeOf } from "#test/support/kernel/shape.ts"
import { breaks, oneHole } from "#test/support/kernel/sqlgen.ts"
import {
	auditStatementDetailed,
	auditStatementViolations,
	auditTextViolations,
	meetsStoredRow
} from "#test/support/oracle/verify/sql.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	generatedSketchGen,
	type Live,
	type LiveFeature,
	type LiveSketch,
	realSketches,
	resolveLive,
	type Twinned
} from "#test/unit/sql/audit/live.ts"
import {
	type AuditRule,
	type FaithfulRewrite,
	faithfulRewrites,
	leadingWords,
	requiredFaithfulRewrites,
	requiredStatementBreaks,
	type StatementBreak,
	type StatementBreakName,
	statementBreaks,
	type TextBreak,
	textBreaks
} from "#test/unit/sql/audit/operators.ts"

/** The rules of the violations, each once, sorted and joined: what a break must report exactly. */
export const ruleSet = (violations: ReadonlyArray<{ readonly rule: AuditRule }>): string =>
	Arr.join(Arr.sort([...new Set(Arr.map(violations, (v) => v.rule))], Order.String), ", ")

/** A printed statement cut to 1200 characters, as a failure quotes it. */
export const clip = (text: string): string =>
	text.length > 1200 ? `${Str.slice(0, 1200)(text)}...` : text

/**
 * The type every use of each placeholder index is cast to, by its printed form: an expression's placeholder is cast to
 * its type, an input array's, `unnest($n::<type>[])`, to its column's type made an array (bit(n)'s included, which no
 * TypeRef states), and an input count's to bigint. A constant's CREATE holds none: each `$n` of its body is its own
 * argument, a row function's (physical/ddl/row-functions.ts) as a library function's, which a Bind never supplies.
 */
const placeholderTypes = (s: SqlStatement): ReadonlyMap<number, ReadonlySet<string>> => {
	const types = new Map<number, Set<string>>()
	if (s.kind === "createConstant") {
		return types
	}
	const use = (index: number, printed: string): void => {
		const seen = types.get(index) ?? new Set<string>()
		seen.add(printed)
		types.set(index, seen)
	}
	const arrayOf = (type: TypeRef): string => (type.array ? printType(type) : `${printType(type)}[]`)
	transformStatement(s, {
		...identityHooks,
		expr: (e) => {
			if (e.kind === "param") {
				use(e.slot.number, printType(e.type))
			}
			return e
		},
		fromSource: (item) => {
			if (item.kind === "arrays") {
				const source = item.source
				if (source.kind === "count") {
					use(source.count.number, printType(builtinType("bigint")))
				} else {
					for (const c of source.columns) {
						use(c.array.number, arrayOf(c.definition.type))
					}
				}
			}
			return item
		}
	})
	return types
}

/** The universal checks every Live statement passes. */
export const universal = (t: Twinned): void => {
	const s = t.statement
	const text = printStatement(s)
	assert.deepEqual(
		Arr.map(auditStatementViolations(s), (v) => `${v.rule} at ${v.where}: ${v.detail}`),
		[],
		clip(text)
	)
	assert.deepEqual(
		Arr.map(auditTextViolations(text), (v) => `${v.rule} at ${v.where}: ${v.detail}`),
		[],
		clip(text)
	)
	assert.equal(printStatement(t.twin), text, "a twin built apart prints alike")
	assert.equal(
		transformStatement(s, identityHooks),
		s,
		"a traversal that changes nothing keeps the statement"
	)
	const written = succeeded(writeJsonText(s), "the snapshot writer writes an admitted statement")
	const read = succeeded(decode(written, noRevivers), "the snapshot reader reads its own statement")
	assert.equal(
		succeeded(encode(read, everyProperty), "the read statement's canonical text"),
		succeeded(encode(s, everyProperty), "the statement's canonical text"),
		"the snapshot stores the statement as itself and reads it back as itself"
	)
	const emitted = succeeded(emit(s, emptyNameMap), "emit emits an admitted statement")
	assert.equal<string>(emitted.text, text, "emit prints the statement")
	const order: ReadonlyArray<TypeRef> = auditStatementDetailed(s).params
	const used = placeholderTypes(s)
	assert.equal(order.length, used.size, "one type per placeholder index")
	assert.equal(
		statementParams(s),
		s.kind === "createConstant" ? s.params.length : order.length,
		"the parameters a Bind of the statement supplies, or a constant's arguments, which statementParams counts"
	)
	for (const [i, type] of order.entries()) {
		unorderedEqual([...(used.get(i + 1) ?? [])], [printType(type)], `$${i + 1}`)
	}
}

/** The statement of a Live draw that a break case acts on: one, picked, so a case stays small. */
interface StatementPick {
	readonly kind: number
	readonly statement: number
}

/** Picks, since the kinds and statements are known only once the draw is resolved. */
const statementPickGen: Gen<StatementPick> = (source) => ({
	kind: source.draw(pickGen),
	statement: source.draw(pickGen)
})

/** Statements in the order of their kinds' names, so the statements of one kind sit together. */
const byKind = Order.mapInput(Order.String, (s: SqlStatement) => s.kind)

/** Statements grouped by kind, the kinds in the order of their names, each group in the order the statements came. */
const groupsOf = (
	statements: Arr.NonEmptyReadonlyArray<Twinned>
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<SqlStatement>> =>
	Arr.groupWith(
		Arr.sort(
			Arr.map(statements, (t) => t.statement),
			byKind
		),
		(a, b) => a.kind === b.kind
	)

/**
 * A kind uniformly among the kinds the statements hold, then a statement of it: a DDL kind that is one of sixty
 * statements of an installation is reached as often as SELECT.
 */
export const pickedStatement = (
	statements: Arr.NonEmptyReadonlyArray<Twinned>,
	pick: StatementPick
): SqlStatement => pickFrom(pickFrom(groupsOf(statements), pick.kind), pick.statement)

/**
 * How a suite's operators meet a statement: what the suite reads of a statement, the situations an operator reaches
 * in what it read, and whether the operator has a site there. A property notes exactly what `reaches` names for each
 * operator with a site, and an aimed case picks by the same two, so what is aimed at is what gets noted.
 */
interface Reaching<V, O, F extends string> {
	readonly view: (s: SqlStatement) => V
	readonly operators: ReadonlyArray<O>
	readonly reaches: (v: V, operator: O) => Arr.NonEmptyReadonlyArray<Reached<F>>
	readonly applies: (v: V, operator: O) => boolean
}

/** Notes one situation a case reached: a feature, or a pair of them. */
export const noteReached = <F extends string>(c: Case<F>, situation: Reached<F>): void => {
	if (typeof situation === "string") {
		c.note(situation)
	} else {
		c.pair(situation[0], situation[1])
	}
}

/**
 * Whether an operator of `reaching` has a site in statement `t` and reaches one of the situations `aimed` holds, by
 * their keys.
 */
const reachesAimed =
	<V, O, F extends string>(reaching: Reaching<V, O, F>, aimed: ReadonlySet<string>) =>
	(t: Twinned): boolean => {
		const v = reaching.view(t.statement)
		return Arr.some(
			reaching.operators,
			(operator) =>
				Arr.some(reaching.reaches(v, operator), (situation) => aimed.has(keyOf(situation))) &&
				reaching.applies(v, operator)
		)
	}

/**
 * The statements a case picks among: those of the draw with a site of an operator that reaches a situation its sketch
 * aims at, when the draw holds one, so a pending situation's site is picked while it is pending rather than left to its
 * share of chance; every statement where it aims at none, or the draw holds no site of one.
 */
export const candidates = <V, O, F extends string>(
	live: Live,
	aims: ReadonlyArray<Reached<F>>,
	reaching: Reaching<V, O, F>
): Arr.NonEmptyReadonlyArray<Twinned> =>
	Arr.match(Arr.filter(live.statements, reachesAimed(reaching, new Set(Arr.map(aims, keyOf)))), {
		onEmpty: () => live.statements,
		onNonEmpty: (picked) => picked
	})

/**
 * What a break case draws: the Live source, the statement it acts on, the site each operator picks, and the situations
 * it aims at.
 */
interface BreakCase<F extends string> {
	readonly live: LiveSketch
	readonly statement: StatementPick
	readonly sites: ReadonlyArray<number>
	readonly aims: ReadonlyArray<Reached<F>>
}

/** A break case of a Live source `live` draws, its picks, a site for each of `operators`, aiming at `aims`. */
export const breakCaseOf =
	<F extends string>(
		live: Gen<LiveSketch>,
		operators: number,
		aims: ReadonlyArray<Reached<F>>
	): Gen<BreakCase<F>> =>
	(source) => ({
		live: source.draw(live),
		statement: source.draw(statementPickGen),
		sites: source.draw(array(pickGen, { min: operators, max: operators })),
		aims
	})

/**
 * The Live source a case aimed at `situation` draws: one of the real outputs whose statements hold a site of an
 * operator that reaches it, where any does, so the statement the case picks holds one; otherwise a generated statement,
 * the source of every form the kernel draws and no installation or drafted migration holds.
 */
const sourceAimedAt =
	<V, O, F extends string>(reaching: Reaching<V, O, F>, situation: Reached<F>): Gen<LiveSketch> =>
	(source) =>
		Arr.match(
			Arr.filter(realSketches, (sketch) =>
				Arr.some(
					resolveLive(sketch).statements,
					reachesAimed(reaching, new Set([keyOf(situation)]))
				)
			),
			{
				onEmpty: () => source.draw(generatedSketchGen),
				onNonEmpty: (holders) => source.draw(element(holders))
			}
		)

/**
 * For each of `situations`, the break cases aimed at it: a Live source holding a site of an operator that reaches it,
 * and picks among the statements holding one, so a case whose turn aims at a pending situation meets its site.
 */
export const breakAims = <V, O, F extends string>(
	reaching: Reaching<V, O, F>,
	situations: Situations<F>
): ReadonlyArray<readonly [Reached<F>, Gen<BreakCase<F>>]> =>
	Arr.map(
		situations,
		(situation) =>
			[
				situation,
				breakCaseOf(sourceAimedAt(reaching, situation), reaching.operators.length, [situation])
			] as const
	)

/**
 * What a Live draw reached: its source, each statement's kind and shape, and the float literals the persisted forms
 * once lost (NaN, the infinities and -0).
 */
export type AuditLiveFeature =
	| LiveFeature
	| ShapeFeature
	| `statement ${SqlStatement["kind"]}`
	| "float literal special"
	| "float literal negative zero"
	| "old under IS TRUE in an INSERT's RETURNING"

/** What the audit-live suite notes of a draw: its own features, and each statement's kind, shape and float literals. */
export const auditLiveFeatures = (live: Live): ReadonlyArray<AuditLiveFeature> => [
	...live.features,
	...Arr.flatMap(live.statements, ({ statement }): ReadonlyArray<AuditLiveFeature> => {
		const floats: Array<AuditLiveFeature> = []
		transformStatement(statement, {
			...identityHooks,
			expr: (e) => {
				if (e.kind === "literal" && e.value.kind === "floatSpecial") {
					floats.push(
						e.value.value === "-0" ? "float literal negative zero" : "float literal special"
					)
				}
				return e
			}
		})
		return [`statement ${statement.kind}`, ...shapeFeatures(shapeOf(statement)), ...floats]
	})
]

/** Whether an expression names a row's old image. */
const namesOld = (e: Expr): boolean => {
	const sides: Array<"old" | "new"> = []
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "returning") {
				sides.push(x.side)
			}
			return x
		}
	})
	return sides.includes("old")
}

/**
 * Whether a write is an INSERT whose RETURNING names old under IS TRUE where its ON CONFLICT returns the stored row it
 * meets (`meetsStoredRow`), as write/insert/protocol.ts's met marker does.
 */
export const marksMet = (w: SqlStatement | CteBody): boolean =>
	w.kind === "insert" &&
	meetsStoredRow(w) &&
	Arr.some(w.returning, (t) => t.expr.kind === "isTrue" && namesOld(t.expr.expr))

/** Whether a statement or a data-modifying CTE of its WITH, the only place PostgreSQL admits one, is a write `holds` holds of. */
export const writesWhere = (
	s: SqlStatement,
	holds: (w: SqlStatement | CteBody) => boolean
): boolean => {
	const ctes =
		s.kind === "select" ||
		s.kind === "insert" ||
		s.kind === "update" ||
		s.kind === "delete" ||
		s.kind === "merge"
			? (s.with?.ctes ?? [])
			: []
	return holds(s) || Arr.some(ctes, (c) => holds(c.query))
}

/** What a break case reached: each break, each rule, and each rule beside the kind of statement it broke. */
export type BreakFeature =
	| `break ${StatementBreakName}`
	| `rule ${AuditRule}`
	| `statement ${SqlStatement["kind"]}`

/** What a faithful rewrite case reached: each rewrite. */
export type FaithfulFeature = `rewrite ${string}`

/** What a text break case reached: each break, and each rule beside the leading words of the text it broke. */
export type TextBreakFeature =
	| `text break ${string}`
	| `text rule ${AuditRule}`
	| `leading ${string}`

/** How a statement break meets a statement: each break with a site, its rule, and its rule beside the kind it breaks. */
export const breakReaching: Reaching<SqlStatement, StatementBreak, BreakFeature> = {
	view: (s) => s,
	operators: statementBreaks,
	reaches: (s, b) => [
		`break ${b.name}`,
		`rule ${b.rule}`,
		[`rule ${b.rule}`, `statement ${s.kind}`]
	],
	applies: (s, b) => Arr.isReadonlyArrayNonEmpty(breaks(s, b))
}

/** How a faithful rewrite meets a statement: each rewrite with a hole in it. */
export const faithfulReaching: Reaching<SqlStatement, FaithfulRewrite, FaithfulFeature> = {
	view: (s) => s,
	operators: faithfulRewrites,
	reaches: (_s, r) => [`rewrite ${r.name}`],
	applies: (s, r) => Arr.isReadonlyArrayNonEmpty(oneHole(s, r.holes))
}

/** How a text break meets a statement's print: each break with a site, and its rule beside the print's leading words. */
export const textReaching: Reaching<string, TextBreak, TextBreakFeature> = {
	view: printStatement,
	operators: textBreaks,
	reaches: (printed, b) => [
		`text break ${b.name}`,
		[`text rule ${b.rule}`, `leading ${leadingWords(printed)}`]
	],
	applies: (printed, b) => Arr.isReadonlyArrayNonEmpty(b.variants(printed))
}

/** The situations every Live draw must reach. */
export const liveSituations: Situations<AuditLiveFeature> = [
	"source generated",
	"source planted",
	"source lowered",
	"source installed",
	"source drafted",
	"context snapshot",
	"context transaction",
	"statement select",
	"statement insert",
	"statement update",
	"statement delete",
	"statement merge",
	"statement createTable",
	"statement createIndex",
	"statement createDomain",
	"statement createFunction",
	"statement grant",
	"from arrays",
	"lateral",
	"with recursive",
	"float literal special",
	"float literal negative zero"
]

/** The situations the statements of every generated write program must reach. */
export const writtenSituations: Situations<AuditLiveFeature> = [
	"source written",
	"a member deleted under a mutable owner",
	"statement select",
	"statement insert",
	"statement emptyCarrier",
	"cte insert",
	"cte delete",
	"from arrays",
	"old under IS TRUE in an INSERT's RETURNING"
]

/** The breaks and rules a broken statement must reach. */
export const breakSituations: Situations<BreakFeature> = Arr.appendAll(
	Arr.map(requiredStatementBreaks, (b): BreakFeature => `break ${b.name}`),
	Arr.map(
		Arr.dedupe(Arr.map(statementBreaks, (b) => b.rule)),
		(rule): BreakFeature => `rule ${rule}`
	)
)

/** The faithful rewrites a rewritten statement must reach. */
export const faithfulSituations: Situations<FaithfulFeature> = Arr.map(
	requiredFaithfulRewrites,
	(r): FaithfulFeature => `rewrite ${r.name}`
)

/** The text breaks, and the rules beside the leading words, a broken print must reach. */
export const textBreakSituations: Situations<TextBreakFeature> = Arr.appendAll(
	Arr.map(textBreaks, (b): TextBreakFeature => `text break ${b.name}`),
	[
		["text rule null", "leading CREATE TABLE"],
		["text rule untypedLiteral", "leading CREATE OR"]
	] as const
)
