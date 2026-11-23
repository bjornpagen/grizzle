/** What the properties of rosters.test.ts read: its spaces, models and helpers. */
import { assert } from "@bjornpagen/testing/assert"
import {
	accepted,
	type Answer,
	type Machine,
	type Program,
	type Real,
	refused,
	type Step as CommandStep,
	type StepFeature,
	took,
	type Verdict
} from "@bjornpagen/testing/commands"
import { constant, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Result, String as Str } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { canonicalTextOf, everyProperty } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { Action, Declarations, Draft, Step } from "#compiler/deploy/diff/plan.ts"
import { type MigrationDraft, draftMigration } from "#compiler/deploy/render/generate.ts"
import {
	codebookOf,
	emptySnapshot,
	noWorkload,
	rosterFates,
	spellingsOf,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { installed } from "#compiler/deploy/snapshot/objects.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { CodeSlot, RosterCodes } from "#compiler/ir/cells.ts"
import { draftCodebook, firstCodebook, noRenames, reorderRefusal } from "#compiler/ir/codes.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { theoryViolations } from "#compiler/laws/model/violations.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { hexOfText, setText, setWidth } from "#test/support/closed/bit-text.ts"
import {
	closed,
	closedRelation,
	contained,
	f,
	on,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { lawNamesOf, parsedName } from "#test/support/kernel/naming.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import { owning } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

/** The handles the roster may ever declare: the box's bound of four. */
const universe = ["a", "b", "c", "d"] as const
type Handle = (typeof universe)[number]

/** One code as the model keeps it: the handle that took it, and whether it is still live. A dead code is a hole. */
interface Coded {
	readonly handle: Handle
	readonly live: boolean
}

/** The closed relation's rows: one fact, or two. Both keep its law. */
type Rows = "one" | "two"

/** What a change of the closed rows declares: lawful rows, or rows whose value is no key, which break its law. */
type RowsDrawn = Rows | "broken"

/** The model: the roster's codes in code order, whether the stored relation has a set over the roster, and the
 * closed relation's rows. The roster's handles in declared order are its live codes' handles in code order. */
interface Model {
	readonly codes: ReadonlyArray<Coded>
	readonly set: boolean
	readonly rows: Rows
}

interface Params {
	readonly grow: undefined
	readonly remove: Handle
	readonly "re-add": Handle
	readonly reorder: number
	readonly "add a set": undefined
	readonly regenerate: undefined
	readonly "change the closed rows": RowsDrawn
}

type Refusal = "reordered" | "closed law broken"

export type Feature = StepFeature<Params, Refusal>

export const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"grow accepted",
	"remove accepted",
	"re-add accepted",
	"reorder refused reordered",
	"add a set accepted",
	"regenerate accepted",
	"change the closed rows accepted",
	"change the closed rows refused closed law broken"
]

const live = (m: Model): ReadonlyArray<Handle> =>
	Arr.flatMap(m.codes, (c) => (c.live ? [c.handle] : []))

/** The first handle of the universe the roster never declared. */
const freshOf = (m: Model): Handle | undefined =>
	Option.getOrUndefined(Arr.findFirst(universe, (h) => !Arr.some(m.codes, (c) => c.handle === h)))

/** The handles the roster declared once and does not declare now. */
const removedOf = (m: Model): ReadonlyArray<Handle> =>
	Arr.filter(universe, (h) => Arr.some(m.codes, (c) => c.handle === h) && !Arr.contains(live(m), h))

const nonEmpty = <A>(values: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> => {
	if (!Arr.isReadonlyArrayNonEmpty(values)) {
		return assert.fail("the harness names a choice among none")
	}
	return values
}

const initial: Model = { codes: [{ handle: "a", live: true }], set: false, rows: "one" }

export const machine: Machine<Model, Params, Refusal> = {
	initial,
	commands: {
		grow: {
			weight: 1,
			applies: (m) => freshOf(m) !== undefined,
			parameters: () => constant(undefined),
			judge: (m) => {
				const h = freshOf(m)
				return h === undefined
					? assert.fail("grow applies only while a fresh handle remains")
					: accepted({ ...m, codes: [...m.codes, { handle: h, live: true }] })
			}
		},
		remove: {
			weight: 1,
			applies: (m) => live(m).length >= 2,
			parameters: (m) => element(nonEmpty(live(m))),
			judge: (m, h) =>
				accepted({
					...m,
					codes: Arr.map(m.codes, (c) =>
						c.live && c.handle === h ? { handle: h, live: false } : c
					)
				})
		},
		"re-add": {
			weight: 1,
			applies: (m) => removedOf(m).length > 0,
			parameters: (m) => element(nonEmpty(removedOf(m))),
			judge: (m, h) => accepted({ ...m, codes: [...m.codes, { handle: h, live: true }] })
		},
		reorder: {
			weight: 1,
			applies: (m) => live(m).length >= 2,
			parameters: (m) => int(0, live(m).length - 2),
			judge: () => refused("reordered")
		},
		"add a set": {
			weight: 1,
			applies: (m) => !m.set,
			parameters: () => constant(undefined),
			judge: (m) => accepted({ ...m, set: true })
		},
		regenerate: {
			weight: 1,
			applies: () => true,
			parameters: () => constant(undefined),
			judge: (m) => accepted(m)
		},
		"change the closed rows": {
			weight: 1,
			applies: () => true,
			parameters: (m) =>
				element<RowsDrawn>(m.rows === "one" ? ["two", "broken"] : ["one", "broken"]),
			judge: (m, rows) =>
				rows === "broken" ? refused("closed law broken") : accepted({ ...m, rows })
		}
	}
}

/** What a step declares to the real system: the roster's handles in declared order, the set, the closed rows, and
 * the handles it drops, which a migration declares (`--drop R#h`). */
interface Declaration {
	readonly handles: Arr.NonEmptyReadonlyArray<Handle>
	readonly set: boolean
	readonly rows: RowsDrawn
	readonly drops: ReadonlyArray<Handle>
}

const declarationOf = (m: Model): Declaration => ({
	handles: nonEmpty(live(m)),
	set: m.set,
	rows: m.rows,
	drops: []
})

/** The declaration with the live handles at `at` and `at + 1` exchanged: a reorder. */
const reordered = (m: Model, at: number): Declaration => {
	const handles = live(m)
	return {
		...declarationOf(m),
		handles: nonEmpty(
			Arr.map(handles, (h, i) =>
				i === at ? (handles[at + 1] ?? h) : i === at + 1 ? (handles[at] ?? h) : h
			)
		)
	}
}

const pairRows: {
	readonly [R in RowsDrawn]: ReadonlyArray<Readonly<Record<string, LiteralDesc>>>
} = {
	one: [{ k: "x", v: "x" }],
	two: [
		{ k: "x", v: "x" },
		{ k: "y", v: "y" }
	],
	broken: [{ k: "x", v: "y" }]
}

/** A second closed relation's rows, with an open payload: its value at `x` changes between the lawful rows, while its
 * cells stay the same, the one value of its dictionary always code 0, so only its dictionary is a new constant and its
 * cells are one constant whose pack names other values. */
const weightRows: {
	readonly [R in RowsDrawn]: ReadonlyArray<Readonly<Record<string, LiteralDesc>>>
} = {
	one: [{ k: "x", w: 1 }],
	two: [{ k: "x", w: 2 }],
	broken: [{ k: "x", w: 1 }]
}

/** The closed-only law: every value of the closed relation is one of its keys. */
const pairLaw = contained(on("Pair", ["v"]), on("Pair", ["k"]))

/** The stored relation T: a closed id of R, one of Q, the field `g` PostgreSQL generates as Pair's value at `q`
 * (C.at), and a set over R when declared. */
const storedT = (set: boolean): SchemaDesc["relations"][number] => {
	const t = relation(
		"T",
		set
			? { id: f.uuid, k: f.closedId("R"), q: f.closedId("Q"), s: { kind: "bits", roster: "R" } }
			: { id: f.uuid, k: f.closedId("R"), q: f.closedId("Q") },
		["id"]
	)
	return {
		...t,
		fields: {
			...t.fields,
			g: {
				type: f.closedId("Q"),
				writing: {
					kind: "generated",
					expr: {
						kind: "closedAt",
						relation: "Pair",
						field: "v",
						args: [{ kind: "field", field: "q" }]
					}
				}
			}
		}
	}
}

/** The schema a declaration states: the roster R, a second roster Q, the stored relation T over R and Q with its
 * generated field reading Pair (with a set over R when declared), and the closed relation Pair over Q with its law. */
const descOf = (d: Declaration): SchemaDesc => ({
	name: "Codes",
	relations: [
		closed.ordered("R", d.handles),
		closed.ordered("Q", ["x", "y"]),
		storedT(d.set),
		closedRelation("Pair", { k: f.closedId("Q"), v: f.closedId("Q") }, ["k"], pairRows[d.rows]),
		closedRelation("Weight", { k: f.closedId("Q"), w: f.integer }, ["k"], weightRows[d.rows])
	],
	statements: [pairLaw],
	bases: []
})

const roster = parsedName("R")

/** The closed-only law's identity, as the law model names it. */
const lawOfPair = (): LawId => lawNamesOf(descOf(declarationOf(initial))).lawOfDesc(pairLaw)

/** What every case reads, a function of the machine alone: the closed law's identity and the first state's snapshot. */
interface Prepared {
	readonly pairLaw: LawId
	readonly first: DeploySnapshot
}

/** The names the roster's codes hold in code order, a hole the empty name. */
const namesOf = (codes: ReadonlyArray<Coded>): ReadonlyArray<string> =>
	Arr.map(codes, (c) => (c.live ? c.handle : ""))

/** The codes as an installation records them. */
const rosterCodesOf = (codes: ReadonlyArray<Coded>): RosterCodes =>
	Arr.map(codes, (c): CodeSlot => (c.live ? { kind: "live", handle: c.handle } : { kind: "hole" }))

/** The live codes of a state of the roster's codes as its live-codes constant's hex, at a set's width. */
const liveOf = (codes: ReadonlyArray<Coded>): string =>
	hexOfText(
		setText(
			codes.length,
			Arr.flatMap(codes, (c, code) => (c.live ? [code] : []))
		)
	)

/** The roster's objects at a state of its codes, named through the naming door from the model's own codes: its names
 * constant by its names, its live-codes constant by its live codes. */
const rosterObjects = (codes: ReadonlyArray<Coded>) => {
	const domain = identity.rosterDomain(roster)
	const bits = identity.bitsDomain(roster, setWidth(codes.length))
	return {
		names: identifierOf(
			identity.rosterConstant(roster, constantDigest("roster-names", namesOf(codes), everyProperty))
		),
		live: identifierOf(
			identity.rosterLive(roster, constantDigest("roster-live", liveOf(codes), everyProperty))
		),
		domain: identifierOf(domain),
		check: identifierOf(identity.domainCheck(domain)),
		bits: identifierOf(bits),
		bitsCheck: identifierOf(identity.domainCheck(bits))
	}
}

const table = identifierOf(identity.table(parsedName("T")))
const setColumn = identifierOf(identity.column(parsedName("s")))
/** T's immutability guard (physical/ddl/immutable.ts) and its trigger, which a data step on T's rows runs without. */
const guard = identifierOf(identity.immutableGuard(parsedName("T")))
const guardTrigger = identifierOf(identity.immutableTrigger())
const generatedColumn = identifierOf(identity.column(parsedName("g")))

/**
 * One drafted statement as the model speaks of it, a word of a closed vocabulary over the names it names: a function
 * created, its PUBLIC revoke or its drop; a domain created or dropped; a domain's CHECK dropped, added NOT VALID or
 * validated; the set column converted to a domain by its cast to bit(n); a column added at its placeholder; T's
 * immutability guard's trigger disabled or enabled, and its function replaced; a law's migration check; or any other
 * statement by its kind, which the model never predicts.
 */
const observedOf = (draft: Draft): ReadonlyArray<string> => {
	const statements = (a: Action): ReadonlyArray<string> => {
		switch (a.kind) {
			case "statement":
				return [statementWord(a.statement)]
			case "alteration":
				return Arr.map(a.actions, (sub) =>
					sub.kind === "addColumnPlaceholder"
						? `placeholder column ${a.table.name}.${sub.column.name}`
						: statementWord({ kind: "alterTable", table: a.table, actions: [sub] })
				)
			case "fill":
				return [`other ${a.kind}`]
			case "violation":
				return [`check law ${a.law}`]
			case "zones":
				return [`check zones ${a.roster}`]
		}
	}
	switch (draft.kind) {
		case "statement":
		case "alteration":
		case "fill":
		case "violation":
		case "zones":
			return statements(draft)
		case "loss":
		case "confirm":
			return [`other ${draft.kind}`]
	}
}

/** A domain action as the model speaks of it. */
const domainWord = (s: Extract<SqlStatement, { readonly kind: "alterDomain" }>): string => {
	const a = s.action
	switch (a.kind) {
		case "dropConstraint":
			return `drop check ${s.name.name}.${a.name}`
		case "addConstraint":
			return a.notValid ? `add check ${s.name.name}.${a.constraint.name}` : `other alterDomain`
		case "validateConstraint":
			return `validate ${s.name.name}.${a.name}`
	}
}

/** A table action as the model speaks of it: a set column's conversion by its cast to bit(n), or another. */
const tableWord = (s: Extract<SqlStatement, { readonly kind: "alterTable" }>): string => {
	const [action, ...rest] = s.actions
	if (rest.length === 0 && action.kind === "setExpression") {
		return `set expression ${s.table.name}.${action.column}`
	}
	if (rest.length > 0 || action.kind !== "alterColumnType" || action.type.kind !== "named") {
		return `other alterTable`
	}
	const using = action.using
	const cast = using.kind === "expr" && using.expr.kind === "cast" ? using.expr.type : undefined
	return cast?.kind === "builtin" && cast.name === "bit"
		? `convert ${s.table.name}.${action.column} to ${action.type.name} by bit(${cast.length})`
		: `other alterTable`
}

const statementWord = (s: SqlStatement): string => {
	if (s.kind === "createFunction" && s.name.name === guard) {
		return `replace guard ${table}`
	}
	if (s.kind === "createConstant") {
		return `create function ${s.name.name}`
	}
	if (s.kind === "packConstant") {
		return `create function ${s.function.name}`
	}
	if (s.kind === "revoke") {
		return s.on.kind === "FUNCTION"
			? `revoke function ${Arr.join(
					Arr.map(s.on.names, (n) => n.name),
					","
				)}`
			: `other revoke`
	}
	if (s.kind === "dropFunction") {
		return `drop function ${s.name.name}`
	}
	if (s.kind === "createDomain") {
		return `create domain ${s.name.name}`
	}
	if (s.kind === "drop") {
		return s.object === "DOMAIN" ? `drop domain ${s.name.name}` : `other drop`
	}
	if (s.kind === "alterDomain") {
		return domainWord(s)
	}
	if (s.kind === "alterTable") {
		return tableWord(s)
	}
	if (s.kind === "dropTrigger") {
		return `drop trigger ${s.table.name}.${s.name}`
	}
	if (s.kind === "createUpdateGuardTrigger") {
		return `create trigger ${s.table.name}.${s.name}`
	}
	return `other ${s.kind}`
}

/** The slots the model speaks for: publish.comments (each new object's COMMENT) and publish.defaults (the PUBLIC
 * revokes, drafted whole whenever the target's change, as a new domain's do) follow rules of their own, outside the
 * roster's. */
type Unspoken = "publish.comments" | "publish.defaults"
type Spoken = Exclude<Step["slot"], Unspoken>

const unspoken = (slot: Step["slot"]): slot is Unspoken =>
	slot === "publish.comments" || slot === "publish.defaults"

/** A step's words by slot, the unspoken slots left out. */
type Seen = ReadonlyMap<Spoken, ReadonlyArray<string>>

const seenOf = (steps: ReadonlyArray<Step>): Seen => {
	const out = new Map<Spoken, Array<string>>()
	for (const s of steps) {
		if (unspoken(s.slot)) {
			continue
		}
		out.set(s.slot, [...(out.get(s.slot) ?? []), ...observedOf(s.draft)])
	}
	return out
}

/** The words of the constants the model does not name, the closed relation's, as the one rule for content-addressed
 * objects predicts them: each constant the target adds created and its PUBLIC revoke, in Setup, and each it removes
 * dropped, in Publish. */
const constantsRule = (
	previous: DeploySnapshot,
	target: DeploySnapshot,
	named: ReadonlySet<string>
): ReadonlyArray<readonly [Spoken, string]> => {
	const functions = (s: DeploySnapshot): ReadonlySet<string> =>
		new Set(
			Arr.flatMap(s.manifest.objects, (o) => {
				const v = installed(o)
				if (v.kind !== "constant") {
					return []
				}
				const name = v.create.name.name
				return named.has(name) ? [] : [name]
			})
		)
	const before = functions(previous)
	const after = functions(target)
	return [
		...Arr.flatMap([...after], (n): ReadonlyArray<readonly [Spoken, string]> =>
			before.has(n)
				? []
				: [
						["setup", `create function ${n}`],
						["setup", `revoke function ${n}`]
					]
		),
		...Arr.flatMap([...before], (n): ReadonlyArray<readonly [Spoken, string]> =>
			after.has(n) ? [] : [["publish.removed", `drop function ${n}`]]
		)
	]
}

/**
 * The words of the tables' declared statistics, which the model does not state, as the one rule for a declaration
 * predicts them: a table's declared statistics declared again, in Indexes, where its declaration changed (its roster
 * column's handles crossed one, or the solver's exponents moved with them) or, the model's table's, one of its columns
 * was converted or given its expression again, whose statistics PostgreSQL clears (README "Declared statistics"); the
 * bookkeeping tables' declarations stand.
 */
const declarationsRule = (
	previous: DeploySnapshot,
	target: DeploySnapshot,
	cleared: boolean
): ReadonlyArray<readonly [Spoken, string]> => {
	const declarations = (s: DeploySnapshot): ReadonlyMap<string, string> =>
		new Map(
			Arr.flatMap(s.manifest.objects, (o) =>
				installed(o).kind === "statistics" ? [[o.ident, canonicalTextOf(o.ddl)] as const] : []
			)
		)
	const before = declarations(previous)
	return Arr.flatMap(
		[...declarations(target)],
		([ident, text]): ReadonlyArray<readonly [Spoken, string]> =>
			(cleared && ident === `statistics:${target.schema}.${table}`) || before.get(ident) !== text
				? [["indexes", "other declareStatistics"]]
				: []
	)
}

/** The model's prediction of an accepted step's words, by slot, from its states before and after. */
const predicted = (
	prepared: Prepared,
	before: Model,
	after: Model,
	rowsChanged: boolean
): ReadonlyArray<readonly [Spoken, string]> => {
	const out: Array<readonly [Spoken, string]> = []
	if (rowsChanged) {
		out.push(
			["setup", `check law ${prepared.pairLaw}`],
			["structure", `set expression ${table}.${generatedColumn}`]
		)
	}
	const was = rosterObjects(before.codes)
	const now = rosterObjects(after.codes)
	const namesChanged = was.names !== now.names
	const liveChanged = was.live !== now.live
	const widened = setWidth(after.codes.length) > setWidth(before.codes.length)
	if (namesChanged) {
		out.push(
			["setup", `create function ${now.names}`],
			["setup", `revoke function ${now.names}`],
			["publish.removed", `drop function ${was.names}`]
		)
	}
	if (liveChanged) {
		out.push(
			["setup", `create function ${now.live}`],
			["setup", `revoke function ${now.live}`],
			["structure", `drop check ${now.domain}.${now.check}`],
			["structure", `add check ${now.domain}.${now.check}`],
			["publish.validate", `validate ${now.domain}.${now.check}`],
			["publish.removed", `drop function ${was.live}`]
		)
	}
	if (after.set) {
		if (!before.set) {
			out.push(
				["setup", `create domain ${now.bits}`],
				["structure", `placeholder column ${table}.${setColumn}`],
				["structure", `drop trigger ${table}.${guardTrigger}`],
				["structure.immediate", "other setConstraintsImmediate"],
				["structure.constraints", `create trigger ${table}.${guardTrigger}`],
				["validate", `replace guard ${table}`]
			)
		} else if (liveChanged) {
			if (widened) {
				out.push(
					["setup", `create domain ${now.bits}`],
					[
						"structure",
						`convert ${table}.${setColumn} to ${now.bits} by bit(${setWidth(after.codes.length)})`
					],
					["publish.removed", `drop domain ${was.bits}`]
				)
			} else {
				out.push(
					["structure", `drop check ${now.bits}.${now.bitsCheck}`],
					["structure", `add check ${now.bits}.${now.bitsCheck}`],
					["publish.validate", `validate ${now.bits}.${now.bitsCheck}`]
				)
			}
		}
	}
	return out
}

const bySlot = (words: ReadonlyArray<readonly [Spoken, string]>): Seen => {
	const out = new Map<Spoken, Array<string>>()
	for (const [slot, word] of words) {
		out.set(slot, [...(out.get(slot) ?? []), word])
	}
	return out
}

/** A slot's words as a multiset: the contract fixes which statements a slot holds, and the orders below. */
const sortedSeen = (seen: Seen): ReadonlyArray<readonly [string, ReadonlyArray<string>]> =>
	Arr.map(
		Arr.sort(
			[...seen],
			Order.mapInput(Order.String, ([slot]: readonly [Spoken, ReadonlyArray<string>]) => slot)
		),
		([slot, words]) => [slot, Arr.sort(words, Order.String)] as const
	)

/** The orders the contract fixes inside a slot: a domain's CHECK dropped before it is added again under its name, a
 * function's PUBLIC revoke after its creation, and in publish.removed a domain before the constants, and a live
 * constant before the names constant its body reads. */
const holdsOrders = (seen: Seen, at: string): void => {
	const before = (slot: Spoken, first: string, second: string) => {
		const words = seen.get(slot) ?? []
		const i = words.indexOf(first)
		const j = words.indexOf(second)
		if (i >= 0 && j >= 0) {
			assert.ok(i < j, `${at}: in ${slot}, ${first} runs before ${second}`)
		}
	}
	const after = (prefix: string, word: string): string | undefined =>
		Str.startsWith(prefix)(word) ? Str.slice(prefix.length)(word) : undefined
	for (const word of seen.get("structure") ?? []) {
		const check = after("add check ", word)
		if (check !== undefined) {
			before("structure", `drop check ${check}`, word)
		}
	}
	for (const word of seen.get("setup") ?? []) {
		const fn = after("revoke function ", word)
		if (fn !== undefined) {
			before("setup", `create function ${fn}`, word)
		}
	}
	const removed = seen.get("publish.removed") ?? []
	for (const word of removed) {
		if (after("drop domain ", word) !== undefined) {
			for (const other of removed) {
				if (after("drop function ", other) !== undefined) {
					before("publish.removed", word, other)
				}
			}
		}
	}
}

/** The first two handles a declaration puts out of their codes' order, by the model's codes: `earlier` declared first
 * and holding the later code. */
const outOfOrder = (
	m: Model,
	d: Declaration
): { readonly earlier: string; readonly later: string } | undefined => {
	const codeOf = (h: Handle): number | undefined =>
		Option.getOrUndefined(Arr.findFirstIndex(m.codes, (c) => c.live && c.handle === h))
	for (let i = 0; i + 1 < d.handles.length; i += 1) {
		const earlier = d.handles[i]
		const later = d.handles[i + 1]
		const a = earlier === undefined ? undefined : codeOf(earlier)
		const b = later === undefined ? undefined : codeOf(later)
		if (
			earlier !== undefined &&
			later !== undefined &&
			a !== undefined &&
			b !== undefined &&
			b < a
		) {
			return { earlier, later }
		}
	}
	return undefined
}

/** What the real system answered a step, and the snapshot it stands at after it. */
interface Stepped {
	readonly answer: Answer<Refusal>
	readonly snapshot: DeploySnapshot
}

/** A draft as `grizzle generate` makes it: the codes drafted from the previous snapshot's, a reorder refused, the
 * installation compiled under them, and the migration drafted. */
const drafting = (
	previous: DeploySnapshot,
	d: Declaration
): Result.Result<
	{ readonly draft: MigrationDraft; readonly installation: Installation },
	CompileError
> => {
	const owned = owning(descOf(d))
	const rosters = rostersOf(owned)
	const declared: Declarations = {
		renames: [],
		drops: Arr.map(d.drops, (handle) => ({ kind: "handle", roster, handle }) as const)
	}
	const codes = draftCodebook(
		rosterFates(
			previous,
			declared,
			Arr.map(rosters, (r) => r.closed)
		),
		noRenames,
		rosters,
		spellingsOf(previous)
	)
	if (!codes.ok) {
		return Result.fail(reorderRefusal(codes.error))
	}
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], codes.value)
		)
	)
	const draft = draftMigration({
		previous,
		installation,
		workload: noWorkload,
		declared,
		abandoned: []
	})
	return draft.ok ? Result.succeed({ draft: draft.value, installation }) : Result.fail(draft.error)
}

const emptyOf = (): DeploySnapshot => emptySnapshot({ schemaName: "Codes", schema: "codes" })

/** A fresh installation's snapshot of a declaration: drafted from the empty snapshot under the first codebook. */
const freshOfDeclaration = (d: Declaration): DeploySnapshot => {
	const owned = owning(descOf(d))
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
		)
	)
	const draft = draftMigration({
		previous: emptyOf(),
		installation,
		workload: noWorkload,
		declared: { renames: [], drops: [] },
		abandoned: []
	})
	if (!draft.ok) {
		return assert.fail(`a fresh installation drafts: ${draft.error.message}`)
	}
	return draft.value.snapshot
}

/** Whether the law's violation query has a row over the target's closed rows, by the reference evaluator, a second
 * implementation of the query's meaning. */
const lawBroken = (pairLawId: LawId, installation: Installation): boolean => {
	const violations = succeeded(
		theoryViolations(installation.laws.checked, installation.laws.theory)
	)
	const forbid = violations.forbids.get(pairLawId)
	if (forbid?.kind !== "Forbid") {
		return assert.fail("the theory's violation queries hold the closed law's Forbid")
	}
	const reference = Reference.of(violations.dag, {
		schema: { name: "Codes", relations: [], closed: [], containments: [] },
		facts: {},
		params: {},
		functions: noFunctions,
		observer: unobserved
	})
	return reference.eval(forbid.violation, noBindings).rows.length > 0
}

/** One step of the real system from the snapshot it stands at, checked against the model's claim. */
const judged = (
	prepared: Prepared,
	previous: DeploySnapshot,
	before: Model,
	after: Model,
	declared: Declaration,
	at: string
): Stepped => {
	const drafted = drafting(previous, declared)
	if (Result.isFailure(drafted)) {
		const pair = outOfOrder(before, declared)
		if (pair === undefined) {
			return assert.fail(`${at}: a declaration in code order drafts: ${drafted.failure.message}`)
		}
		assert.deepEqual(
			drafted.failure.reason,
			reorderRefusal({ roster, ...pair }).reason,
			`${at}: a reorder is refused at its first pair out of code order`
		)
		return { answer: refused("reordered"), snapshot: previous }
	}
	const { draft, installation } = drafted.success
	const rowsChanged = declared.rows !== before.rows
	const checked = Arr.some(
		draft.plan.steps,
		(s) => s.slot === "setup" && s.draft.kind === "violation" && s.draft.law === prepared.pairLaw
	)
	assert.equal(
		checked,
		rowsChanged,
		`${at}: the closed law is checked exactly when its rows change`
	)
	if (rowsChanged && lawBroken(prepared.pairLaw, installation)) {
		return { answer: refused("closed law broken"), snapshot: previous }
	}
	if (declared.rows === "broken") {
		return assert.fail(`${at}: rows that break the closed law are judged broken`)
	}
	const seen = seenOf(draft.plan.steps)
	const named = new Set(
		Arr.flatMap([before.codes, after.codes], (codes) => {
			const o = rosterObjects(codes)
			return [o.names, o.live]
		})
	)
	const expected = bySlot([
		...predicted(prepared, before, after, rowsChanged),
		...constantsRule(previous, draft.snapshot, named),
		...declarationsRule(
			previous,
			draft.snapshot,
			Arr.some(draft.plan.steps, (st) =>
				Arr.some(
					observedOf(st.draft),
					(w) => Str.startsWith("convert ")(w) || Str.startsWith("set expression ")(w)
				)
			)
		)
	])
	assert.deepEqual(sortedSeen(seen), sortedSeen(expected), `${at}: the draft's statements by slot`)
	holdsOrders(seen, at)
	const nothing = canonicalTextOf(before) === canonicalTextOf(after)
	assert.equal(draft.change, nothing ? "none" : "schema", `${at}: a regenerate drafts nothing`)
	if (nothing) {
		assert.equal(draft.snapshot.fingerprint, previous.fingerprint, `${at}: no change, one snapshot`)
	}
	const codes = rosterCodesOf(after.codes)
	assert.deepEqual(
		codebookOf(draft.snapshot).rosters.get(roster)?.codes,
		codes,
		`${at}: the snapshot records the model's codes`
	)
	const read = readBack(draft, at)
	assert.deepEqual(
		codebookOf(read).rosters.get(roster)?.codes,
		codes,
		`${at}: the written snapshot's codes read back`
	)
	const holed = Arr.some(after.codes, (c) => !c.live)
	assert.equal(
		freshOfDeclaration(declared).fingerprint === draft.snapshot.fingerprint,
		!holed,
		`${at}: a fresh installation is the migrated one's snapshot exactly when no code is a hole`
	)
	return { answer: took, snapshot: read }
}

/** A snapshot as the next draft reads it: its written files read back, as `grizzle generate` reads them. */
const readBack = (draft: MigrationDraft, at: string): DeploySnapshot => {
	const read = readSnapshot(
		succeeded(writeSnapshot(draft.snapshot, draft.derived), `${at}: its files`)
	)
	if (Result.isFailure(read)) {
		return assert.fail(`${at}: the written snapshot reads back: ${read.failure.message}`)
	}
	return read.success.snapshot
}

/** The installed first state: the model's initial declaration drafted from the empty snapshot, once. */
/** The first state's snapshot, drafted from the empty snapshot and read back. */
const firstSnapshot = (): DeploySnapshot => {
	const drafted = drafting(emptyOf(), declarationOf(initial))
	if (Result.isFailure(drafted)) {
		return assert.fail(`the first state drafts: ${drafted.failure.message}`)
	}
	return readBack(drafted.success.draft, "the first state")
}

/** A program's prefix by its key: each step's command and parameter, in order. */
const pathKey = (path: Program<Params>): string =>
	Arr.join(
		Arr.map(path, (s) => `${s.command}(${String(s.parameters)})`),
		" "
	)

/** The real system: each step the program takes answered from the box's transitions, by the prefix it ends. */
export const realOf = (
	transitions: ReadonlyMap<string, Stepped>
): Real<Model, Params, Refusal, never, never> => {
	const taken: Array<CommandStep<Params>> = []
	const step = (s: CommandStep<Params>) =>
		Effect.sync(() => {
			taken.push(s)
			const key = pathKey(taken)
			return (transitions.get(key) ?? assert.fail(`the box holds the transition ${key}`)).answer
		})
	return {
		grow: (parameters) => step({ command: "grow", parameters }),
		remove: (parameters) => step({ command: "remove", parameters }),
		"re-add": (parameters) => step({ command: "re-add", parameters }),
		reorder: (parameters) => step({ command: "reorder", parameters }),
		"add a set": (parameters) => step({ command: "add a set", parameters }),
		regenerate: (parameters) => step({ command: "regenerate", parameters }),
		"change the closed rows": (parameters) =>
			step({ command: "change the closed rows", parameters })
	}
}

/** The declaration a step makes the system read: the model after it, with a removal's drop, a reorder or new rows. */
const declaredFor = (s: CommandStep<Params>, before: Model, after: Model): Declaration => {
	switch (s.command) {
		case "grow":
		case "re-add":
		case "add a set":
		case "regenerate":
			return declarationOf(after)
		case "remove":
			return { ...declarationOf(after), drops: [s.parameters] }
		case "reorder":
			return reordered(before, s.parameters)
		case "change the closed rows":
			return { ...declarationOf(before), rows: s.parameters }
	}
}

/** Every step the model can take in a state: each command that applies, with each parameter it may draw there. */
const stepsFrom = (m: Model): ReadonlyArray<CommandStep<Params>> => {
	const fresh = freshOf(m)
	const handles = live(m)
	return [
		...(fresh === undefined ? [] : [{ command: "grow", parameters: undefined } as const]),
		...(handles.length >= 2
			? Arr.map(handles, (h) => ({ command: "remove", parameters: h }) as const)
			: []),
		...Arr.map(removedOf(m), (h) => ({ command: "re-add", parameters: h }) as const),
		...(handles.length >= 2
			? Arr.map(
					upTo(handles.length - 1, (i) => i),
					(i) => ({ command: "reorder", parameters: i }) as const
				)
			: []),
		...(m.set ? [] : [{ command: "add a set", parameters: undefined } as const]),
		{ command: "regenerate", parameters: undefined },
		...Arr.map(
			m.rows === "one" ? (["two", "broken"] as const) : (["one", "broken"] as const),
			(rows) => ({ command: "change the closed rows", parameters: rows }) as const
		)
	]
}

/** The model's state after a step, as its judge claims it. */
const judgedStep = (m: Model, s: CommandStep<Params>): Model => {
	switch (s.command) {
		case "grow":
			return claimed(m, machine.commands.grow.judge(m, s.parameters))
		case "remove":
			return claimed(m, machine.commands.remove.judge(m, s.parameters))
		case "re-add":
			return claimed(m, machine.commands["re-add"].judge(m, s.parameters))
		case "reorder":
			return claimed(m, machine.commands.reorder.judge(m, s.parameters))
		case "add a set":
			return claimed(m, machine.commands["add a set"].judge(m, s.parameters))
		case "regenerate":
			return claimed(m, machine.commands.regenerate.judge(m, s.parameters))
		case "change the closed rows":
			return claimed(m, machine.commands["change the closed rows"].judge(m, s.parameters))
	}
}

const claimed = (m: Model, v: Verdict<Model, Refusal>): Model =>
	v.kind === "accepted" ? v.next : m

/** The bound of the box's paths: a program's states before its sixth step. */
const DEPTH = 5

/** A state the box holds, with the first path that reaches it. */
interface Reached {
	readonly model: Model
	readonly path: Program<Params>
}

/** Every state at most DEPTH steps reach, breadth first, read once. */
const explored = (): Arr.NonEmptyReadonlyArray<Reached> => {
	const seen = new Map<string, Reached>([[canonicalTextOf(initial), { model: initial, path: [] }]])
	let frontier: ReadonlyArray<Reached> = [{ model: initial, path: [] }]
	for (let depth = 0; depth < DEPTH; depth += 1) {
		const next: Array<Reached> = []
		for (const r of frontier) {
			for (const s of stepsFrom(r.model)) {
				const model = judgedStep(r.model, s)
				const key = canonicalTextOf(model)
				if (seen.has(key)) {
					continue
				}
				const state = { model, path: [...r.path, s] }
				seen.set(key, state)
				next.push(state)
			}
		}
		frontier = next
	}
	return nonEmpty([...seen.values()])
}

/** The box: a reached state's path, then one step it can take. */
const boxOf =
	(reached: Arr.NonEmptyReadonlyArray<Reached>): Gen<Program<Params>> =>
	(source) => {
		const state = source.draw(element(reached))
		const step = source.draw(element(nonEmpty(stepsFrom(state.model))))
		return [...state.path, step]
	}

/** Every state at most DEPTH steps reach, each with the first path that reaches it, breadth first. */
const reached = explored()

/** The box: every state at most DEPTH steps reach, with every step it can take next. */
export const boxGen: Gen<Program<Params>> = boxOf(reached)

/**
 * Every transition the box's programs take, by the prefix it ends (pathKey): from each reached state, at the snapshot
 * its path leaves, each step it can take, drafted and judged once. A program of the box is a reached state's path and
 * one step, and every prefix of that path is a reached state's path, so the 1,043 programs take only the box's
 * transitions; built once, when a worker readies the box (the need's open, outside every case's deadline), each is
 * drafted once, where a case used to draft every step of its path again. A judgement that fails fails the need's open,
 * and so the property.
 */
export const transitions: Need<ReadonlyMap<string, Stepped>> = {
	key: "test/unit/deploy/rosters.fixtures.ts transitions",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const prepared: Prepared = { pairLaw: lawOfPair(), first: firstSnapshot() }
		const table = new Map<string, Stepped>()
		for (const r of reached) {
			const from = pathKey(r.path)
			const snapshot =
				r.path.length === 0
					? prepared.first
					: (table.get(from) ?? assert.fail(`the box reaches ${from} before its steps`)).snapshot
			for (const s of stepsFrom(r.model)) {
				const after = judgedStep(r.model, s)
				const key = pathKey([...r.path, s])
				table.set(
					key,
					judged(prepared, snapshot, r.model, after, declaredFor(s, r.model, after), key)
				)
			}
		}
		const taken: ReadonlyMap<string, Stepped> = table
		return Effect.succeed(taken)
	})
}
