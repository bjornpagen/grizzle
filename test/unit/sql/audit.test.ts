import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore, type Kept } from "@grizzle/testing/explore"
import { features, type Reached } from "@grizzle/testing/features"
import { array, type Gen, int, map, oneOf, subarray } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	Schema,
	String as Str
} from "effect"
import { SqlStatementSchema } from "#adapter/boundary/sql.ts"
import { decode, noRevivers } from "#compiler/core/canonical.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"
import type { CteBody, SqlStatement, TypeRef } from "#compiler/sql/ast.ts"
import { builtinType } from "#compiler/sql/build.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"
import { statementForm } from "#compiler/sql/form.ts"
import { carrierName, emptyNameMap } from "#compiler/sql/naming.ts"
import { printStatement, printType } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { type ShapeFeature, shapeFeatures, shapeOf } from "#test/support/kernel/shape.ts"
import { breaks, oneHole } from "#test/support/kernel/sqlgen.ts"
import {
	auditCarrierProgramViolations,
	auditStatementDetailed,
	auditStatementViolations,
	auditTextViolations,
	violationError
} from "#test/support/oracle/verify/sql.ts"
import { pickFrom, pickGen, pickOf } from "#test/support/pick.ts"
import {
	breakSketchGen,
	type Live,
	type LiveFeature,
	type LiveSketch,
	liveSketchGen,
	plantedSketches,
	plantedSpecials,
	resolveLive,
	textBreakSketchGen,
	type Twinned,
	writtenSketchGen
} from "#test/unit/sql/audit/live.ts"

import {
	type AuditRule,
	auditRuleReason,
	faithfulRewrites,
	leadingWords,
	type StatementBreakName,
	statementBreaks,
	textBreaks
} from "#test/unit/sql/audit/operators.ts"

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
 * kind every draw holds once is reached as often as one it holds sixty times: the statement audit reports that rule
 * and no other, under the reason the rule maps to (MalformedDescription for structure, UnsupportedOperation for the
 * emission discipline). Its faithful rewrites are admitted and print as declared.
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
 * its type, and a recordset's, `jsonb_to_recordset($n::jsonb)`, to jsonb.
 */
const placeholderTypes = (s: SqlStatement): ReadonlyMap<number, ReadonlySet<string>> => {
	const types = new Map<number, Set<string>>()
	const use = (index: number, type: TypeRef): void => {
		const seen = types.get(index) ?? new Set<string>()
		seen.add(printType(type))
		types.set(index, seen)
	}
	transformStatement(s, {
		...identityHooks,
		expr: (e) => {
			if (e.kind === "param") {
				use(e.slot.number, e.type)
			}
			return e
		},
		fromItem: (item) => {
			if (item.kind === "recordset") {
				use(item.source.number, builtinType("jsonb"))
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
	/**
	 * The engine writes the snapshot form natively (sql/form.ts) and the shell's codec reads it back, so the two agree
	 * on every admitted statement: the engine's form is the bytes the codec encodes, and the codec decodes it to the
	 * statement itself. Encoding reads the statement through the codec's type side first, so its success is the type
	 * side's admission of the statement as the compiler holds it.
	 */
	const written = succeeded(
		writeJsonText(statementForm(s)),
		"the snapshot writer writes an admitted statement"
	)
	const encoded = succeeded(
		Schema.encodeResult(SqlStatementSchema)(s),
		"the codec encodes an admitted statement"
	)
	assert.equal(written, succeeded(writeJsonText(encoded)), "the engine's form is the codec's")
	const read = succeeded(
		Schema.decodeUnknownResult(SqlStatementSchema)(succeeded(decode(written, noRevivers))),
		"the snapshot reader reads its own statement"
	)
	assert.deepEqual(read, s, "the snapshot's codec reads the statement back as itself")
	const emitted = succeeded(emit(s, emptyNameMap, unmetered), "emit emits an admitted statement")
	assert.equal<string>(emitted.text, text, "emit prints the statement")
	const order: ReadonlyArray<TypeRef> = auditStatementDetailed(s).params
	const used = placeholderTypes(s)
	assert.equal(order.length, used.size, "one type per placeholder index")
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

/** A draw's statements grouped by kind, each kind where its first statement is. */
const groupsOf = (live: Live): ReadonlyArray<Arr.NonEmptyReadonlyArray<SqlStatement>> => {
	const groups = new Map<SqlStatement["kind"], Arr.NonEmptyArray<SqlStatement>>()
	for (const { statement } of live.statements) {
		const group = groups.get(statement.kind)
		if (group === undefined) {
			groups.set(statement.kind, [statement])
		} else {
			group.push(statement)
		}
	}
	return [...groups.values()]
}

/**
 * A kind uniformly among the kinds the draw holds, then a statement of it: a DDL kind that is one of sixty
 * statements of an installation is reached as often as SELECT.
 */
const pickedStatement = (live: Live, pick: StatementPick): SqlStatement | undefined => {
	const [first, ...rest] = groupsOf(live)
	return first === undefined
		? undefined
		: pickFrom(pickFrom([first, ...rest], pick.kind), pick.statement)
}

/** The planted Live draws (live.ts plantedSketches), each resolved once, when the module loads. */
const plantedLives: ReadonlyArray<{ readonly sketch: LiveSketch; readonly live: Live }> = Arr.map(
	plantedSketches(),
	(sketch) => ({ sketch, live: resolveLive(sketch) })
)

/**
 * The first statement of the planted draws that `holds`, with its draw and the pick that selects it. A requirement no
 * planted statement meets fails where it is declared.
 */
const plantedStatement = (
	what: string,
	holds: (s: SqlStatement) => boolean
): {
	readonly at: { readonly live: LiveSketch; readonly statement: StatementPick }
	readonly picked: SqlStatement
} => {
	for (const { sketch, live } of plantedLives) {
		const groups = groupsOf(live)
		for (const [g, group] of groups.entries()) {
			const found = Arr.findFirstWithIndex(group, holds)
			if (Option.isSome(found)) {
				const [picked, j] = found.value
				return {
					at: {
						live: sketch,
						statement: { kind: pickOf(g, groups.length), statement: pickOf(j, group.length) }
					},
					picked
				}
			}
		}
	}
	throw new Error(`no planted statement holds ${what}`)
}

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
		return [`statement ${statement.kind}`, ...shapeFeatures(shapeOf(statement)), ...floats]
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

describe("every Live statement", () => {
	it.effect(
		"passes both audits, prints as its twin does, survives the snapshot's codec and emit, and lowers deterministically",
		(ctx) => {
			const required: ReadonlyArray<AuditLiveFeature> = [
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
				"statement createEnum",
				"statement createFunction",
				"statement createConstraintTrigger",
				"statement grant",
				"from recordset",
				"lateral",
				"with recursive",
				"float literal special",
				"float literal negative zero"
			]
			/**
			 * Planted: the float specials (live.ts plantedSpecials), and the first planted draw reaching each feature the
			 * drawn sources reach a few times a run.
			 */
			const kept: ReadonlyArray<Kept<LiveSketch, AuditLiveFeature>> = [
				{
					note: "the float specials",
					sketch: plantedSpecials,
					draws: "",
					reaches: ["float literal special"]
				},
				...Arr.map(
					[
						"source drafted",
						"statement insert",
						"statement update",
						"statement delete",
						"statement merge",
						"statement createConstraintTrigger",
						"lateral",
						"with recursive"
					] as const,
					(feature): Kept<LiveSketch, AuditLiveFeature> => ({
						note: feature,
						sketch: Option.getOrThrowWith(
							Arr.findFirst(plantedLives, ({ live }) => auditLiveFeatures(live).includes(feature)),
							() => new Error(`a planted draw reaching ${feature}`)
						).sketch,
						draws: "",
						reaches: [feature]
					})
				)
			]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/sql/audit-live",
						draw: drawn(liveSketchGen),
						literal: Formatter.format,
						features: features<AuditLiveFeature>(required),
						kept,
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
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
			const required: ReadonlyArray<AuditLiveFeature> = [
				"source written",
				"statement select",
				"statement insert",
				"statement createCarrier",
				"statement analyze",
				"cte insert",
				"cte delete",
				"from recordset",
				"overriding system value"
			]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/sql/audit-written",
						draw: drawn(writtenSketchGen),
						literal: Formatter.format,
						features: features<AuditLiveFeature>(required),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
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
})

describe("a statement broken at one site", () => {
	it.effect(
		"is refused by the audit for exactly the rule it breaks, under that rule's reason",
		(ctx) => {
			const required: ReadonlyArray<BreakFeature> = [
				...Arr.map(
					Arr.filter(statementBreaks, (b) => b.required),
					(b) => `break ${b.name}` as const
				),
				...Arr.map(
					[...new Set(Arr.map(statementBreaks, (b) => b.rule))],
					(rule) => `rule ${rule}` as const
				)
			]
			/** Planted: every required break, on the first planted statement it has a site in. */
			const kept: ReadonlyArray<Kept<BreakCase, BreakFeature>> = Arr.map(
				Arr.filter(statementBreaks, (b) => b.required),
				(b): Kept<BreakCase, BreakFeature> => ({
					note: b.name,
					sketch: {
						...plantedStatement(b.name, (s) => breaks(s, b).length > 0).at,
						sites: Arr.map(statementBreaks, () => 0)
					},
					draws: "",
					reaches: [`break ${b.name}`, `rule ${b.rule}`]
				})
			)
			return searched(
				ctx,
				explore(
					{
						suite: "unit/sql/audit-breaks",
						draw: drawn(breakCaseGen(breakSketchGen, statementBreaks.length)),
						literal: Formatter.format,
						features: features<BreakFeature>(required),
						kept,
						/**
						 * Every break, every rule and every rule beside each kind it breaks is required: 300 cases reach them.
						 */
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					({ live: sketch, statement, sites }, c) =>
						Effect.sync(() => {
							const live = resolveLive(sketch)
							const s = defined(pickedStatement(live, statement), "a Live draw holds a statement")
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
								c.note(`break ${operator.name}`)
								c.note(`rule ${operator.rule}`)
								c.pair(`rule ${operator.rule}`, `statement ${s.kind}`)
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
			const required: ReadonlyArray<FaithfulFeature> = Arr.map(
				Arr.filter(faithfulRewrites, (r) => r.required),
				(r) => `rewrite ${r.name}` as const
			)
			return searched(
				ctx,
				explore(
					{
						suite: "unit/sql/audit-faithful",
						draw: drawn(breakCaseGen(liveSketchGen, faithfulRewrites.length)),
						literal: Formatter.format,
						features: features<FaithfulFeature>(required),
						kept: [],
						/** Every required rewrite is reached: 300 cases reach them. */
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					({ live: sketch, statement, sites }, c) =>
						Effect.sync(() => {
							const live = resolveLive(sketch)
							const s = defined(pickedStatement(live, statement), "a Live draw holds a statement")
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
								c.note(`rewrite ${r.name}`)
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
		const required: ReadonlyArray<Reached<TextBreakFeature>> = [
			...Arr.map(textBreaks, (b) => `text break ${b.name}` as const),
			["text rule null", "leading CREATE TABLE"],
			["text rule untypedLiteral", "leading CREATE OR"],
			["text rule untypedLiteral", "leading ALTER TYPE"]
		]
		/**
		 * Planted: every text break on the first planted statement whose print it has a site in, and each required rule
		 * beside its leading words.
		 */
		const kept: ReadonlyArray<Kept<BreakCase, TextBreakFeature>> = [
			...Arr.map(textBreaks, (b): Kept<BreakCase, TextBreakFeature> => ({
				note: b.name,
				sketch: {
					...plantedStatement(b.name, (s) => b.variants(printStatement(s)).length > 0).at,
					sites: Arr.map(textBreaks, () => 0)
				},
				draws: "",
				reaches: [`text break ${b.name}`]
			})),
			...Arr.map(
				[
					["null", "CREATE TABLE"],
					["untypedLiteral", "CREATE OR"],
					["untypedLiteral", "ALTER TYPE"]
				] as const,
				([rule, leading]): Kept<BreakCase, TextBreakFeature> => {
					const applies = (printed: string) =>
						Arr.findFirst(textBreaks, (b) => b.rule === rule && b.variants(printed).length > 0)
					const { at, picked } = plantedStatement(
						`${rule} beside ${leading}`,
						(s) =>
							leadingWords(printStatement(s)) === leading &&
							Option.isSome(applies(printStatement(s)))
					)
					const broken = Option.getOrThrowWith(
						applies(printStatement(picked)),
						() => new Error("a break of the rule")
					)
					return {
						note: `${rule} beside ${leading}`,
						sketch: { ...at, sites: Arr.map(textBreaks, () => 0) },
						draws: "",
						reaches: [`text break ${broken.name}`]
					}
				}
			)
		]
		return searched(
			ctx,
			explore(
				{
					suite: "unit/sql/audit-text-breaks",
					draw: drawn(breakCaseGen(textBreakSketchGen, textBreaks.length)),
					literal: Formatter.format,
					features: features<TextBreakFeature>(required),
					kept,
					/**
					 * Every text break and every rule beside each leading form it breaks is required: 400 cases reach them.
					 */
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				({ live: sketch, statement, sites }, c) =>
					Effect.sync(() => {
						const live = resolveLive(sketch)
						const s = defined(pickedStatement(live, statement), "a Live draw holds a statement")
						const printed = printStatement(s)
						const kind = leadingWords(printed)
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
							c.note(`text break ${b.name}`)
							c.pair(`text rule ${b.rule}`, `leading ${kind}`)
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
	| { readonly kind: "analyze"; readonly carriers: ReadonlyArray<number> }

type ProgramFeature = "admitted" | "refused"

const programStatement = (step: ProgramStep): SqlStatement =>
	step.kind === "create"
		? {
				kind: "createCarrier",
				name: carrierName(step.carrier),
				columns: [
					{
						name: "c1",
						type: builtinType("bigint"),
						collation: undefined,
						generated: undefined,
						default: undefined
					}
				]
			}
		: { kind: "analyze", carriers: Arr.map(step.carriers, carrierName) }

/** One step on two carriers: a carrier created, or an ANALYZE of any subset of them. */
const programStepGen: Gen<ProgramStep> = oneOf<ProgramStep>([
	map(int(1, 2), (carrier): ProgramStep => ({ kind: "create", carrier })),
	map(subarray([1, 2]), (carriers): ProgramStep => ({ kind: "analyze", carriers }))
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
						features: features<ProgramFeature>(["admitted", "refused"]),
						caseHang: Duration.minutes(2)
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
