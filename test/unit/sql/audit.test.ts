import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { type Reached, required, requiredInSpace, type Situations } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { decode, encode, everyProperty, noRevivers } from "#compiler/core/canonical.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"
import type { CteBody, PlStatement, SqlStatement, TypeRef } from "#compiler/sql/ast.ts"
import { builtinType } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printStatement, printType } from "#compiler/sql/print.ts"
import { identityHooks, statementParams, transformStatement } from "#compiler/sql/transform.ts"
import {
	assert,
	defined,
	refusalLoc,
	refused,
	succeeded,
	unorderedEqual
} from "#test/support/assert.ts"
import { unitCarrier } from "#test/support/kernel/naming.ts"
import { type ShapeFeature, shapeFeatures, shapeOf } from "#test/support/kernel/shape.ts"
import { breaks, oneHole } from "#test/support/kernel/sqlgen.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	auditCarrierProgramViolations,
	auditStatementDetailed,
	auditStatementViolations,
	auditTextViolations,
	violationError
} from "#test/support/oracle/verify/sql.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	breakSketchGen,
	type Live,
	type LiveFeature,
	type LiveSketch,
	liveSketchGen,
	resolveLive,
	type Twinned,
	writtenSketchGen
} from "#test/unit/sql/audit/live.ts"
import {
	type AuditRule,
	auditRuleReason,
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
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"
import { Hand, shopChangeSet, shopCompile, shopWrite } from "#test/unit/write/put/support.ts"

/**
 * The test kernel's structural audit of emitted SQL (test/support/oracle/verify/sql.ts), searched over Live statements
 * and their Wild breaks.
 *
 * The Live statements (audit/live.ts) are the kernel generator's statements, the lowering of generated query cases,
 * the installations and drafted migrations of the fixture schemas, and the compilations of generated write programs.
 * On every one of them:
 *
 * - both audits admit it, its twin built apart prints alike, the snapshot's own codec (the persisted statement
 *   schema's encoding, which reads it through the type side first, and writeJsonText, then canonical decode and the
 *   schema's decoding) reads it back as itself, emit prints it, and the audit hands back the type of each placeholder
 *   at its index;
 * - a lowered or written statement's text is its AST's print, and lowering or compiling the case again, or its twin,
 *   emits the same texts byte for byte.
 *
 * Its Wild breaks (audit/operators.ts) each break one rule at one site of one statement, picked by kind first so a
 * kind every draw holds once is reached as often as one it holds sixty times, and, where a case steers, among the
 * statements holding a site of a situation still pending: the statement audit reports that rule and no other, under
 * the reason the rule maps to (MalformedDescription for structure, UnsupportedOperation for the emission discipline).
 * Its faithful rewrites are admitted and print as declared.
 * Its print, broken at one token, is reported by the text audit as exactly the rule broken.
 *
 * A program's ANALYZE names only carriers an earlier statement of the program created: checked exhaustively over
 * every program of up to three statements on two carriers.
 */
const ruleSet = (violations: ReadonlyArray<{ readonly rule: AuditRule }>): string =>
	Arr.join(Arr.sort([...new Set(Arr.map(violations, (v) => v.rule))], Order.String), ", ")

const clip = (text: string): string =>
	text.length > 1200 ? `${Str.slice(0, 1200)(text)}...` : text

/**
 * The type every use of each placeholder index is cast to, by its printed form: an expression's placeholder is cast to
 * its type, an input array's, `unnest($n::<type>[])`, to its column's type made an array (bit(n)'s included, which no
 * TypeRef states), and an input count's to bigint.
 */
const placeholderTypes = (s: SqlStatement): ReadonlyMap<number, ReadonlySet<string>> => {
	const types = new Map<number, Set<string>>()
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
const universal = (t: Twinned): void => {
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
	assert.equal(statementParams(s), order.length, "the parameters a Bind of the statement supplies")
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
const pickedStatement = (
	statements: Arr.NonEmptyReadonlyArray<Twinned>,
	pick: StatementPick
): SqlStatement => pickFrom(pickFrom(groupsOf(statements), pick.kind), pick.statement)

/**
 * How a suite's operators meet a statement: what the suite reads of a statement, the situations an operator reaches
 * in what it read, and whether the operator has a site there. A property notes exactly what `reaches` names for each
 * operator with a site, and a steered case aims its pick by the same two, so what is aimed at is what gets noted.
 */
interface Reaching<V, O, F extends string> {
	readonly view: (s: SqlStatement) => V
	readonly operators: ReadonlyArray<O>
	readonly reaches: (v: V, operator: O) => Arr.NonEmptyReadonlyArray<Reached<F>>
	readonly applies: (v: V, operator: O) => boolean
}

/** Notes one situation a case reached: a feature, or a pair of them. */
const noteReached = <F extends string>(c: Case<F>, situation: Reached<F>): void => {
	if (typeof situation === "string") {
		c.note(situation)
	} else {
		c.pair(situation[0], situation[1])
	}
}

/**
 * The statements a case picks among. Where the case steers, those of the draw with a site of an operator that reaches
 * a situation still pending, when the draw holds one, so a pending situation's site is picked while it is pending
 * rather than left to its share of chance; every statement once none is pending, and where the case may not steer, so
 * a rotating case and a kept case are plain draws, and a replay, whose token records the steering, picks as its case
 * did.
 */
const candidates = <V, O, F extends string>(
	live: Live,
	steering: Case<F>["steering"],
	reaching: Reaching<V, O, F>
): Arr.NonEmptyReadonlyArray<Twinned> =>
	Option.match(steering, {
		onNone: () => live.statements,
		onSome: (pending) =>
			Arr.match(
				Arr.filter(live.statements, (t) => {
					const v = reaching.view(t.statement)
					return Arr.some(
						reaching.operators,
						(operator) =>
							Arr.some(reaching.reaches(v, operator), pending.has) && reaching.applies(v, operator)
					)
				}),
				{ onEmpty: () => live.statements, onNonEmpty: (aimed) => aimed }
			)
	})

/** What a break case draws: the Live source, the statement it acts on, and the site each operator picks. */
interface BreakCase {
	readonly live: LiveSketch
	readonly statement: StatementPick
	readonly sites: ReadonlyArray<number>
}

const breakCaseGen =
	(live: Gen<LiveSketch>, operators: number): Gen<BreakCase> =>
	(source) => ({
		live: source.draw(live),
		statement: source.draw(statementPickGen),
		sites: source.draw(array(pickGen, { min: operators, max: operators }))
	})

/**
 * What a Live draw reached: its source, each statement's kind and shape, and the float literals the persisted forms
 * once lost (NaN, the infinities and -0).
 */
type AuditLiveFeature =
	| LiveFeature
	| ShapeFeature
	| `statement ${SqlStatement["kind"]}`
	| "float literal special"
	| "float literal negative zero"
	| "overriding system value"
	| "probe and refusal in a CASE WHEN"

/** The PL/pgSQL shapes a block's statements hold: a probe and its refusal inside an exhaustive CASE's WHEN, as a roster's
 * dispatch holds one. */
const plShapes = (
	body: ReadonlyArray<PlStatement>,
	inWhen: boolean
): ReadonlyArray<AuditLiveFeature> =>
	Arr.flatMap(body, (s): ReadonlyArray<AuditLiveFeature> => {
		switch (s.kind) {
			case "whenAbsent":
				return [
					...(inWhen ? (["probe and refusal in a CASE WHEN"] as const) : []),
					...plShapes(s.body, inWhen)
				]
			case "case":
				return Arr.flatMap(s.whens, (w) => plShapes(w.body, true))
			case "if":
				return [
					...Arr.flatMap(s.branches, (b) => plShapes(b.body, inWhen)),
					...plShapes(s.else, inWhen)
				]
			case "forQuery":
				return plShapes(s.body, inWhen)
			case "assign":
			case "perform":
			case "raise":
			case "return":
				return []
		}
	})

/** The law shapes one statement holds: a function's PL/pgSQL shapes. */
const lawShapes = (statement: SqlStatement): ReadonlyArray<AuditLiveFeature> =>
	statement.kind === "createFunction" && statement.language === "plpgsql"
		? plShapes(statement.body.body, false)
		: []

/** What the audit-live suite notes of a draw: its own features, and each statement's kind, shape and float literals. */
const auditLiveFeatures = (live: Live): ReadonlyArray<AuditLiveFeature> => [
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
		return [
			`statement ${statement.kind}`,
			...shapeFeatures(shapeOf(statement)),
			...floats,
			...lawShapes(statement)
		]
	})
]

const explicit = (w: SqlStatement | CteBody): boolean =>
	w.kind === "insert" && w.overriding !== undefined

/**
 * Whether a statement or a data-modifying CTE of its WITH, the only place PostgreSQL admits one, writes an explicit
 * serial: an INSERT with OVERRIDING SYSTEM VALUE.
 */
const overridesSerial = (s: SqlStatement): boolean => {
	const ctes =
		s.kind === "select" ||
		s.kind === "insert" ||
		s.kind === "update" ||
		s.kind === "delete" ||
		s.kind === "merge"
			? (s.with?.ctes ?? [])
			: []
	return explicit(s) || Arr.some(ctes, (c) => explicit(c.query))
}

/** What a break case reached: each break, each rule, and each rule beside the kind of statement it broke. */
type BreakFeature =
	| `break ${StatementBreakName}`
	| `rule ${AuditRule}`
	| `statement ${SqlStatement["kind"]}`

type FaithfulFeature = `rewrite ${string}`

/** What a text break case reached: each break, and each rule beside the leading words of the text it broke. */
type TextBreakFeature = `text break ${string}` | `text rule ${AuditRule}` | `leading ${string}`

/** How a statement break meets a statement: each break with a site, its rule, and its rule beside the kind it breaks. */
const breakReaching: Reaching<SqlStatement, StatementBreak, BreakFeature> = {
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
const faithfulReaching: Reaching<SqlStatement, FaithfulRewrite, FaithfulFeature> = {
	view: (s) => s,
	operators: faithfulRewrites,
	reaches: (_s, r) => [`rewrite ${r.name}`],
	applies: (s, r) => Arr.isReadonlyArrayNonEmpty(oneHole(s, r.holes))
}

/** How a text break meets a statement's print: each break with a site, and its rule beside the print's leading words. */
const textReaching: Reaching<string, TextBreak, TextBreakFeature> = {
	view: printStatement,
	operators: textBreaks,
	reaches: (printed, b) => [
		`text break ${b.name}`,
		[`text rule ${b.rule}`, `leading ${leadingWords(printed)}`]
	],
	applies: (printed, b) => Arr.isReadonlyArrayNonEmpty(b.variants(printed))
}

describe("every Live statement", () => {
	it.effect(
		"passes both audits, prints as its twin does, survives the snapshot's codec and emit, and lowers deterministically",
		(ctx) => {
			const situations: Situations<AuditLiveFeature> = [
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
				"probe and refusal in a CASE WHEN",
				"statement grant",
				"from arrays",
				"lateral",
				"with recursive",
				"float literal special",
				"float literal negative zero"
			]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/sql/audit-live",
						draw: drawn(liveSketchGen),
						literal: Formatter.format,
						coverage: required<AuditLiveFeature>(situations, { cases: 120, sense: notesOnly }),
						kept: [],
						/** The rotating stream's sample: coverage is the floor's and the steered phase's. */
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.sync(() => {
							const live = resolveLive(sketch)
							for (const twinned of live.statements) {
								universal(twinned)
							}
							c.noteAll(auditLiveFeatures(live))
							for (const { ast, text } of live.emitted) {
								assert.equal(text, printStatement(ast), "the emitted text is its AST's print")
							}
							const [first, ...runs] = live.again()
							if (first !== undefined) {
								for (const run of runs) {
									assert.deepEqual(run, first, "lowering the case again emits the same texts")
								}
							}
						})
				)
			)
		}
	)
})

describe("every statement a generated write program places", () => {
	it.effect(
		"passes both audits, prints as its twin does, survives the snapshot's codec and emit, and compiles deterministically",
		(ctx) => {
			const situations: Situations<AuditLiveFeature> = [
				"source written",
				"a member deleted under a mutable owner",
				"statement select",
				"statement insert",
				"statement createCarrier",
				"statement analyze",
				"cte insert",
				"cte delete",
				"from arrays",
				"overriding system value"
			]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/sql/audit-written",
						draw: drawn(writtenSketchGen),
						literal: Formatter.format,
						coverage: required<AuditLiveFeature>(situations, { cases: 60, sense: notesOnly }),
						kept: [],
						/** The rotating stream's sample: coverage is the floor's and the steered phase's. */
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.sync(() => {
							const live = resolveLive(sketch)
							c.noteAll(live.features)
							for (const twinned of live.statements) {
								universal(twinned)
								c.note(`statement ${twinned.statement.kind}`)
								c.noteAll(shapeFeatures(shapeOf(twinned.statement)))
								if (overridesSerial(twinned.statement)) {
									c.note("overriding system value")
								}
							}
							for (const { ast, text } of live.emitted) {
								assert.equal(text, printStatement(ast), "the placed text is its AST's print")
							}
							const [first, ...runs] = live.again()
							if (first !== undefined) {
								for (const run of runs) {
									assert.deepEqual(run, first, "compiling the program again places the same texts")
								}
							}
						})
				)
			)
		}
	)

	it("refuses a member inserted under a stored immutable owner at compile, which the written draws never state", () => {
		const lone = shopChangeSet().insert(Hand, [{ id: uuidOf(6), crew: uuidOf(7), label: "f" }])
		const at = refusalLoc(refused(shopWrite(lone, shopCompile), "UnsupportedOperation"))
		assert.deepEqual(
			{ label: at.label, path: at.path },
			{ label: "insert Hand", path: [] },
			"the refusal is the insert's"
		)
	})

	it("refuses a member's delete under an immutable owner at compile: its family is fixed when its owner is inserted", () => {
		const deleted = shopChangeSet().delete(Hand, [{ id: uuidOf(6), crew: uuidOf(7), label: "f" }])
		const at = refusalLoc(refused(shopWrite(deleted, shopCompile), "UnsupportedOperation"))
		assert.deepEqual(
			{ label: at.label, path: at.path },
			{ label: "delete Hand", path: [] },
			"the refusal is the delete's"
		)
	})
})

describe("a statement broken at one site", () => {
	it.effect(
		"is refused by the audit for exactly the rule it breaks, under that rule's reason",
		(ctx) => {
			const situations: Situations<BreakFeature> = Arr.appendAll(
				Arr.map(requiredStatementBreaks, (b): BreakFeature => `break ${b.name}`),
				Arr.map(
					Arr.dedupe(Arr.map(statementBreaks, (b) => b.rule)),
					(rule): BreakFeature => `rule ${rule}`
				)
			)
			return searched(
				ctx,
				explore(
					{
						suite: "unit/sql/audit-breaks",
						draw: drawn(breakCaseGen(breakSketchGen, statementBreaks.length)),
						literal: Formatter.format,
						coverage: required<BreakFeature>(situations, { cases: 600, sense: notesOnly }),
						kept: [],
						/** The rotating stream's sample: coverage is the floor's and the steered phase's. */
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ live: sketch, statement, sites }, c) =>
						Effect.sync(() => {
							const live = resolveLive(sketch)
							const s = pickedStatement(candidates(live, c.steering, breakReaching), statement)
							const problems: Array<string> = []
							for (const [i, operator] of statementBreaks.entries()) {
								const [first, ...rest] = breaks(s, operator)
								if (first === undefined) {
									continue
								}
								const rewrite = pickFrom(
									[first, ...rest],
									defined(sites[i], "a site drawn per break")
								)
								const found = auditStatementViolations(rewrite.statement)
								const got = ruleSet(found)
								if (got !== operator.rule) {
									problems.push(
										`${operator.name} (${rewrite.kind} ${rewrite.site}): reported [${got}], not [${operator.rule}]\n${clip(printStatement(rewrite.statement))}`
									)
									continue
								}
								const [violation] = found
								if (violation === undefined) {
									problems.push(`${operator.name}: the audit admitted it`)
									continue
								}
								const reason = auditRuleReason[operator.rule]
								const refused = violationError(violation, "statement").reason._tag
								if (refused !== reason) {
									problems.push(`${operator.name}: refused as ${refused}, not ${reason}`)
								}
								for (const situation of breakReaching.reaches(s, operator)) {
									noteReached(c, situation)
								}
							}
							assert.deepEqual(problems, [], `${live.label}\n${clip(printStatement(s))}`)
						})
				)
			)
		}
	)

	it.effect(
		"is admitted when the rewrite is faithful, and prints as the rewrite declares",
		(ctx) => {
			const situations: Situations<FaithfulFeature> = Arr.map(
				requiredFaithfulRewrites,
				(r): FaithfulFeature => `rewrite ${r.name}`
			)
			return searched(
				ctx,
				explore(
					{
						suite: "unit/sql/audit-faithful",
						draw: drawn(breakCaseGen(liveSketchGen, faithfulRewrites.length)),
						literal: Formatter.format,
						coverage: required<FaithfulFeature>(situations, { cases: 300, sense: notesOnly }),
						kept: [],
						/** The rotating stream's sample: coverage is the floor's and the steered phase's. */
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ live: sketch, statement, sites }, c) =>
						Effect.sync(() => {
							const live = resolveLive(sketch)
							const s = pickedStatement(candidates(live, c.steering, faithfulReaching), statement)
							const before = printStatement(s)
							const problems: Array<string> = []
							for (const [i, r] of faithfulRewrites.entries()) {
								const [first, ...rest] = oneHole(s, r.holes)
								if (first === undefined) {
									continue
								}
								const v = pickFrom(
									[first, ...rest],
									defined(sites[i], "a site drawn per rewrite")
								).statement
								const found = auditStatementViolations(v)
								const after = printStatement(v)
								if (found.length > 0) {
									problems.push(`${r.name}: refused [${ruleSet(found)}]\n${clip(after)}`)
								}
								if (r.print === "different" && after === before) {
									problems.push(`${r.name}: prints as the statement it rewrote`)
								}
								for (const situation of faithfulReaching.reaches(s, r)) {
									noteReached(c, situation)
								}
							}
							assert.deepEqual(problems, [], `${live.label}\n${clip(before)}`)
						})
				)
			)
		}
	)
})

describe("a printed statement broken at one token", () => {
	it.effect("is refused by the text audit for exactly the rule it breaks", (ctx) => {
		const situations: Situations<TextBreakFeature> = Arr.appendAll(
			Arr.map(textBreaks, (b): TextBreakFeature => `text break ${b.name}`),
			[
				["text rule null", "leading CREATE TABLE"],
				["text rule untypedLiteral", "leading CREATE OR"]
			] as const
		)
		return searched(
			ctx,
			explore(
				{
					suite: "unit/sql/audit-text-breaks",
					draw: drawn(breakCaseGen(breakSketchGen, textBreaks.length)),
					literal: Formatter.format,
					coverage: required<TextBreakFeature>(situations, { cases: 400, sense: notesOnly }),
					kept: [],
					/** The rotating stream's sample: coverage is the floor's and the steered phase's. */
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ live: sketch, statement, sites }, c) =>
					Effect.sync(() => {
						const live = resolveLive(sketch)
						const s = pickedStatement(candidates(live, c.steering, textReaching), statement)
						const printed = printStatement(s)
						const problems: Array<string> = []
						for (const [i, b] of textBreaks.entries()) {
							const [v, ...vs] = b.variants(printed)
							if (v === undefined) {
								continue
							}
							const broken = pickFrom([v, ...vs], defined(sites[i], "a site drawn per text break"))
							const got = ruleSet(auditTextViolations(broken))
							if (got !== b.rule) {
								problems.push(`${b.name}: reported [${got}], not [${b.rule}]\n${clip(broken)}`)
							}
							for (const situation of textReaching.reaches(printed, b)) {
								noteReached(c, situation)
							}
						}
						assert.deepEqual(problems, [], `${live.label}\n${clip(printed)}`)
					})
			)
		)
	})
})

/** One statement of a write program, as far as its carriers go. */
type ProgramStep =
	| { readonly kind: "create"; readonly carrier: number }
	| { readonly kind: "analyze"; readonly carriers: Arr.NonEmptyReadonlyArray<number> }

type ProgramFeature = "admitted" | "refused"

const programStatement = (step: ProgramStep): SqlStatement =>
	step.kind === "create"
		? {
				kind: "createCarrier",
				name: unitCarrier(step.carrier),
				columns: [
					{
						name: "c1",
						type: builtinType("bigint"),
						collation: undefined,
						generated: undefined
					}
				]
			}
		: { kind: "analyze", carriers: Arr.map(step.carriers, unitCarrier) }

/** One step on two carriers: a carrier created, or an ANALYZE of any nonempty subset of them, as ANALYZE needs one. */
const programStepGen: Gen<ProgramStep> = oneOf<ProgramStep>([
	map(int(1, 2), (carrier): ProgramStep => ({ kind: "create", carrier })),
	map(element<Arr.NonEmptyReadonlyArray<number>>([[1], [2], [1, 2]]), (carriers): ProgramStep => ({
		kind: "analyze",
		carriers
	}))
])

describe("a write program's ANALYZE", () => {
	it.effect(
		"names only carriers an earlier statement created, over every program of three statements on two carriers",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/sql/carrier-program",
						generator: array(programStepGen, { min: 0, max: 3 }),
						literal: Formatter.format,
						limit: 1000,
						coverage: requiredInSpace<ProgramFeature>(["admitted", "refused"]),
						caseHang
					},
					(program, c) =>
						Effect.sync(() => {
							const created = new Set<number>()
							const expected: Array<string> = []
							for (const [i, step] of program.entries()) {
								if (step.kind === "create") {
									created.add(step.carrier)
								} else {
									for (const carrier of step.carriers) {
										if (!created.has(carrier)) {
											expected.push(`context at statement ${i}`)
										}
									}
								}
							}
							const got = Arr.map(
								auditCarrierProgramViolations(Arr.map(program, programStatement)),
								(v) => `${v.rule} at ${v.where}`
							)
							assert.deepEqual(got, expected)
							c.note(expected.length === 0 ? "admitted" : "refused")
						})
				)
			)
	)
})
