/**
 * Roster migrations, drafted with no database: every program of at most six commands (grow, remove, re-add, reorder,
 * add a set, regenerate, change the closed rows) over a roster of at most four handles, exhausted as its steps: every
 * state a program of at most five steps reaches, each with every step it can take next. That box holds every step of
 * every such program, since what the real system stands at after a step is a function of the model's state alone: a
 * draft's snapshot is its target's (the schema the state declares, compiled under the codes the state holds), which
 * each step checks against the state, and the step's draft is a function of that snapshot and the next state's.
 *
 * The oracle is a second implementation of a roster change's draft: the model keeps its own history of the roster's
 * codes (a handle keeps its code, a removed one leaves a hole, a new or re-added one takes the next code) and predicts,
 * slot by slot, every statement a step drafts for the roster: its new names constant (and a set's live constant) in
 * Setup, its domain's CHECK dropped and added NOT VALID in Structure and validated in Validate, a set's bits domain,
 * bit(n) with n the codes rounded up to whole hex digits, re-pointed the same way when its width stands and replaced
 * by a new one of the new width when the roster grows past a whole digit, the set column converted by its cast to
 * bit(n′), and the old functions and domain dropped in Publish. The names the
 * model predicts are minted through the naming door from its own codes. A reorder is refused before anything is
 * drafted, by D1's refusal; a regenerate drafts nothing and leaves the snapshot as it was; a change of the closed
 * relation's rows drafts its law's check first in Setup, and a change whose rows break the law is refused, which a
 * second judge, the reference evaluator of the law's violation query, decides, and the field PostgreSQL generates from
 * the closed relation's rows (C.at) takes its new expression (SET EXPRESSION). The closed relation's own constants are
 * held to the one rule for content-addressed objects: every constant the target adds is created in Setup and every one
 * it removes dropped in Publish. The publish.comments and publish.defaults slots are outside the model's contract.
 *
 * Every accepted step is checked against the state the model claims (doctrine rule 11): the new snapshot's codebook is
 * the model's codes, read from the snapshot and from its written text read back (the round trip), and its fingerprint
 * is a fresh installation's of the same declaration exactly when the roster has no hole. Each step drafts from the
 * snapshot its previous step wrote, read back from its text as `grizzle generate` reads snapshot.json, so a change of
 * the closed rows meets the snapshot an earlier change wrote: among them a closed relation with an open payload, whose
 * cells stay one constant while the values its pack names change.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): rosters-handle-renames-ignored (a roster's declared handle renames
 * ignored when its codes are drafted).
 */
import { describe, it } from "@effect/vitest"
import {
	accepted,
	type Answer,
	type Machine,
	type Program,
	type Real,
	refused,
	runProgram,
	type Step as CommandStep,
	type StepFeature,
	took,
	type Verdict
} from "@grizzle/testing/commands"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { constant, element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result, String as Str } from "effect"
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
	rosterFates
} from "#compiler/deploy/snapshot/build.ts"
import { installed } from "#compiler/deploy/snapshot/objects.ts"
import type { DeploySnapshot, SnapshotFiles } from "#compiler/deploy/snapshot/types.ts"
import type { CodeSlot, RosterCodes } from "#compiler/ir/cells.ts"
import { draftCodebook, firstCodebook, noRenames, reorderRefusal } from "#compiler/ir/codes.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { theoryViolations } from "#compiler/laws/model/violations.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { wholeDigits } from "#test/support/closed/bit-text.ts"
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
import { caseHang } from "#test/support/limits.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
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

type Feature = StepFeature<Params, Refusal>

const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
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

const machine: Machine<Model, Params, Refusal> = {
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
		closed("R", d.handles),
		closed("Q", ["x", "y"]),
		storedT(d.set),
		closedRelation("Pair", { k: f.closedId("Q"), v: f.closedId("Q") }, ["k"], pairRows[d.rows]),
		closedRelation("Weight", { k: f.closedId("Q"), w: f.integer }, ["k"], weightRows[d.rows])
	],
	statements: [pairLaw],
	extends: undefined
})

const roster = parsedName("R")

/** The closed-only law's identity, as the law model names it. */
const lawOfPair = (): LawId => lawNamesOf(descOf(declarationOf(initial))).lawOfDesc(pairLaw)

/**
 * What the search reads in every case, computed once before it runs: the closed law's identity, the first state's
 * snapshot and every reached state; and its own caches, each of the search alone, of the fresh snapshot of each
 * declaration and of each transition it has judged, keyed by their canonical text.
 */
interface Prepared {
	readonly pairLaw: LawId
	readonly first: DeploySnapshot
	readonly reached: Arr.NonEmptyReadonlyArray<Reached>
	readonly fresh: Map<string, DeploySnapshot>
	readonly transitions: Map<string, Stepped>
}

/** The names the roster's codes hold in code order, a hole the empty name. */
const namesOf = (codes: ReadonlyArray<Coded>): ReadonlyArray<string> =>
	Arr.map(codes, (c) => (c.live ? c.handle : ""))

/** The codes as an installation records them. */
const rosterCodesOf = (codes: ReadonlyArray<Coded>): RosterCodes =>
	Arr.map(codes, (c): CodeSlot => (c.live ? { kind: "live", handle: c.handle } : { kind: "hole" }))

/** The roster's objects at a state of its codes, named through the naming door from the model's own codes. */
const rosterObjects = (codes: ReadonlyArray<Coded>) => {
	const digest = constantDigest("roster-names", namesOf(codes), everyProperty)
	const domain = identity.rosterDomain(roster)
	const bits = identity.bitsDomain(roster, wholeDigits(codes.length))
	return {
		names: identifierOf(identity.rosterConstant(roster, digest)),
		live: identifierOf(identity.rosterLive(roster, digest)),
		domain: identifierOf(domain),
		check: identifierOf(identity.domainCheck(domain)),
		bits: identifierOf(bits),
		bitsCheck: identifierOf(identity.domainCheck(bits))
	}
}

const table = identifierOf(identity.table(parsedName("T")))
const setColumn = identifierOf(identity.column(parsedName("s")))
const generatedColumn = identifierOf(identity.column(parsedName("g")))

/**
 * One drafted statement as the model speaks of it, a word of a closed vocabulary over the names it names: a function
 * created, its PUBLIC revoke or its drop; a domain created or dropped; a domain's CHECK dropped, added NOT VALID or
 * validated; the set column converted to a domain by its cast to bit(n); a column added at its placeholder; a law's
 * migration check; or any other statement by its kind, which the model never predicts.
 */
const observedOf = (draft: Draft): ReadonlyArray<string> => {
	const statements = (a: Action): ReadonlyArray<string> => {
		switch (a.kind) {
			case "statement":
				return [statementWord(a.statement)]
			case "placeholderColumn":
				return [`placeholder column ${a.table.name}.${a.column.name}`]
			case "violation":
				return [`check law ${a.law}`]
			case "placeholderRetype":
			case "analyze":
			case "dropStatistics":
				return [`other ${a.kind}`]
		}
	}
	switch (draft.kind) {
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "violation":
		case "analyze":
		case "dropStatistics":
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
				const name =
					v.create.kind === "createConstant" ? v.create.name.name : v.create.function.name
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
	const namesChanged =
		canonicalTextOf(namesOf(before.codes)) !== canonicalTextOf(namesOf(after.codes))
	const widened = wholeDigits(after.codes.length) > wholeDigits(before.codes.length)
	if (namesChanged) {
		out.push(["setup", `create function ${now.names}`], ["setup", `revoke function ${now.names}`])
		out.push(
			["structure", `drop check ${now.domain}.${now.check}`],
			["structure", `add check ${now.domain}.${now.check}`],
			["validate", `validate ${now.domain}.${now.check}`],
			["publish.removed", `drop function ${was.names}`]
		)
	}
	if (after.set) {
		if (!before.set) {
			out.push(
				["setup", `create function ${now.live}`],
				["setup", `revoke function ${now.live}`],
				["setup", `create domain ${now.bits}`],
				["structure", `placeholder column ${table}.${setColumn}`]
			)
		} else if (namesChanged) {
			out.push(
				["setup", `create function ${now.live}`],
				["setup", `revoke function ${now.live}`],
				["publish.removed", `drop function ${was.live}`]
			)
			if (widened) {
				out.push(
					["setup", `create domain ${now.bits}`],
					[
						"structure",
						`convert ${table}.${setColumn} to ${now.bits} by bit(${wholeDigits(after.codes.length)})`
					],
					["publish.removed", `drop domain ${was.bits}`]
				)
			} else {
				out.push(
					["structure", `drop check ${now.bits}.${now.bitsCheck}`],
					["structure", `add check ${now.bits}.${now.bitsCheck}`],
					["validate", `validate ${now.bits}.${now.bitsCheck}`]
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
		rosters
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
const freshOfDeclaration = (prepared: Prepared, d: Declaration): DeploySnapshot => {
	const key = canonicalTextOf(d)
	const known = prepared.fresh.get(key)
	if (known !== undefined) {
		return known
	}
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
	prepared.fresh.set(key, draft.value.snapshot)
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
		observer: unobserved
	})
	return reference.eval(forbid.violation, noBindings).rows.length > 0
}

/** One step of the real system from the snapshot it stands at, checked against the model's claim. */
/** Each distinct transition is drafted and judged once in a search: the real snapshot before it, the model before it,
 * and the step. */
const stepOf = (
	prepared: Prepared,
	previous: DeploySnapshot,
	before: Model,
	after: Model,
	declared: Declaration,
	refusing: Refusal | undefined,
	at: string
): Stepped => {
	const key = canonicalTextOf([previous.fingerprint, before, after, declared, refusing ?? ""])
	const known = prepared.transitions.get(key)
	if (known !== undefined) {
		return known
	}
	const result = judged(prepared, previous, before, after, declared, at)
	prepared.transitions.set(key, result)
	return result
}

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
		...constantsRule(previous, draft.snapshot, named)
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
	const read = readBack(draft.snapshotFiles, at)
	assert.deepEqual(
		codebookOf(read).rosters.get(roster)?.codes,
		codes,
		`${at}: the written snapshot's codes read back`
	)
	const holed = Arr.some(after.codes, (c) => !c.live)
	assert.equal(
		freshOfDeclaration(prepared, declared).fingerprint === draft.snapshot.fingerprint,
		!holed,
		`${at}: a fresh installation is the migrated one's snapshot exactly when no code is a hole`
	)
	return { answer: took, snapshot: read }
}

/** A snapshot as the next draft reads it: its written files read back, as `grizzle generate` reads them. */
const readBack = (files: SnapshotFiles, at: string): DeploySnapshot => {
	const read = readSnapshot(files)
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
	return readBack(drafted.success.draft.snapshotFiles, "the first state")
}

/** The real system: the snapshot each step continues, advanced by every step it takes. */
const realOf = (prepared: Prepared): Real<Model, Params, Refusal, never, never> => {
	let snapshot = prepared.first
	let at = 0
	const step = (
		before: Model,
		after: Model,
		declared: Declaration,
		refusing: Refusal | undefined
	) =>
		Effect.sync(() => {
			at += 1
			const stepped = stepOf(prepared, snapshot, before, after, declared, refusing, `step ${at}`)
			snapshot = stepped.snapshot
			return stepped.answer
		})
	return {
		grow: (_, before, after) => step(before, after, declarationOf(after), undefined),
		remove: (h, before, after) =>
			step(before, after, { ...declarationOf(after), drops: [h] }, undefined),
		"re-add": (_, before, after) => step(before, after, declarationOf(after), undefined),
		reorder: (i, before, after) => step(before, after, reordered(before, i), "reordered"),
		"add a set": (_, before, after) => step(before, after, declarationOf(after), undefined),
		regenerate: (_, before, after) => step(before, after, declarationOf(after), undefined),
		"change the closed rows": (rows, before, after) =>
			step(
				before,
				after,
				{ ...declarationOf(before), rows },
				rows === "broken" ? "closed law broken" : undefined
			)
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

describe("roster migrations", () => {
	it.effect(
		"draft exactly the model's statements, slot by slot, for every program of at most six roster commands over four handles, refusing a reorder and a broken closed law",
		(ctx) => {
			const prepared: Prepared = {
				pairLaw: lawOfPair(),
				first: firstSnapshot(),
				reached: explored(),
				fresh: new Map(),
				transitions: new Map()
			}
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/rosters",
						generator: boxOf(prepared.reached),
						literal: Formatter.format,
						limit: 4_000,
						box: "every state a program of at most five commands (grow, remove, re-add, reorder, add a set, regenerate, change the closed rows) reaches over a roster of at most four handles, from a roster of one handle with no set, with every step it can take next",
						oracle: {
							kind: "second-implementation",
							name: "a model of the roster's codes predicting each step's statements by slot, with the reference evaluator judging the closed law"
						},
						coverage: requiredInSpace<Feature>(FEATURES),
						caseHang
					},
					(steps, c) =>
						Effect.gen(function* () {
							const ran = yield* runProgram(machine, realOf(prepared), steps)
							for (const verdict of ran.verdicts) {
								c.note(verdict)
							}
						})
				)
			)
		}
	)
})
