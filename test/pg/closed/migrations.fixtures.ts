/** What the properties of migrations.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as EngineResult from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, nonEmpty, unorderedEqual } from "@bjornpagen/testing/assert"
import {
	accepted,
	type Machine,
	type Program,
	program,
	type Real,
	refused,
	took
} from "@bjornpagen/testing/commands"
import { constant, element, type Gen, map, subset, type Steered } from "@bjornpagen/testing/gen"
import { type Swarm, swarm } from "@bjornpagen/testing/swarm"
import { Array as Arr, Effect, Option, Order, Record as Rec, type Scope, Struct } from "effect"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { scalarReader } from "#compiler/codec/read.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { Declarations, Draft } from "#compiler/deploy/diff/plan.ts"
import { planFiles } from "#compiler/deploy/phases/files.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { codebookOf, rosterFates, spellingsOf } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { draftCodebook, noRenames } from "#compiler/ir/codes.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { login } from "#compiler/program/workload/login.ts"
import { bits, closedId, pg } from "#compiler/public/fields.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type AnyRole,
	closed,
	contained,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { closedBuilder } from "#compiler/schema/relation.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	apply,
	kept,
	noFurther,
	openMigrator,
	reviewedSource,
	type Reviewer
} from "#test/pg/migrate/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { hexOfText, setText, setWidth } from "#test/support/closed/bit-text.ts"
import { liveConstantOf, liveHeld, modelLive } from "#test/support/closed/constants.ts"
import {
	codeAt,
	type Declaration,
	declarationOf,
	installedGen,
	liveHandleGen,
	liveOf,
	liveSubsetGen,
	reorderedPair,
	rosterMachine,
	type RosterParameters,
	type RosterState,
	sizeOf
} from "#test/support/closed/generate.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { migrated, type Version, workloadOf } from "#test/support/installed.ts"
import { lawIdOf, parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftedAt, fromSnapshot, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import { planRealInstall } from "#test/support/oracle/install/real.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { outputText, paramText } from "#test/support/wire.ts"

/** The roster whose history a program drives. */
const tierName = parsedName("Tier")

/** The closed relations' roster, which no command changes. */
const nodeHandles = ["North", "South", "East"] as const

type NodeHandle = (typeof nodeHandles)[number]

/** The sets a Sets relation stores, or none before a command adds it. */
type SetsModel =
	| { readonly kind: "absent" }
	| { readonly kind: "present"; readonly rows: ReadonlyArray<ReadonlyArray<number>> }

/** The rows of the closed relations: Allowed's nodes, and the nodes Edge's rows leave from, each to itself. */
interface ClosedRows {
	readonly allowed: NonEmptyReadonlyArray<NodeHandle>
	readonly from: NonEmptyReadonlyArray<NodeHandle>
}

/** The model: the roster's codes, the codes Held's rows store in id order, Sets' sets, and the closed rows. */
interface Model {
	readonly tier: RosterState
	readonly held: ReadonlyArray<number>
	readonly sets: SetsModel
	readonly closedRows: ClosedRows
}

/** When a removal's data step runs: drafted into the folder before VALIDATE, or after VALIDATE refused it. */
const dataSteps = ["drafted", "after a refusal"] as const

type DataStep = (typeof dataSteps)[number]

/** Each command's parameters. */
interface Params {
	readonly grow: RosterParameters["grow"]
	readonly remove: RosterParameters["remove"] & {
		readonly data: DataStep
		readonly drop: DropDeclaration
	}
	readonly readd: RosterParameters["readd"]
	readonly reorder: RosterParameters["reorder"]
	readonly write: { readonly handle: string }
	readonly "add sets": Readonly<Record<string, never>>
	readonly "write set": { readonly members: ReadonlyArray<string> }
	readonly regenerate: Readonly<Record<string, never>>
	readonly "closed rows": ClosedRows
}

/**
 * Whether a removal declares its drop (`--drop Roster#handle`): every handle whose code becomes a hole is data a
 * migration loses, which only a declared drop loses, so an undeclared one is refused before anything is drafted.
 */
const dropDeclarations = ["declared", "undeclared"] as const

type DropDeclaration = (typeof dropDeclarations)[number]

/** What the model refuses: a reorder, a removal whose drop is undeclared, and closed rows that break their law. */
type Refusal = "reordered" | "undeclared" | "law"

/** A step's situation, for coverage. */
export type Feature =
	| "a handle grown"
	| "a handle removed"
	| "a removed name declared again"
	| "a reorder refused"
	| "an undeclared drop refused"
	| "VALIDATE refused a removed code a row holds"
	| "VALIDATE refused a removed bit a set holds"
	| "a data step drafted"
	| "a set column widened"
	| "a set stored"
	| "nothing drafted"
	| "closed rows refused by their law"
	| "closed rows changed"

const commandNames = Object.freeze(
	Struct.keys<Record<keyof Params, unknown>>({
		grow: 0,
		remove: 0,
		readd: 0,
		reorder: 0,
		write: 0,
		"add sets": 0,
		"write set": 0,
		regenerate: 0,
		"closed rows": 0
	})
)

/** The roster machine's commands, over the model's roster. */
const rosterCommands = (state: RosterState) => rosterMachine(state).commands

/** The codes of the roster's live handles, ascending. */
const liveCodes = (state: RosterState): ReadonlyArray<number> =>
	Arr.flatMap(state.slots, (slot, code) => (slot.kind === "live" ? [code] : []))

/** The model after the roster's change to `tier`, the rows and sets holding a code it removed losing it. */
const withTier = (m: Model, tier: RosterState): Model => {
	const live = new Set(liveCodes(tier))
	return {
		...m,
		tier,
		held: Arr.filter(m.held, (code) => live.has(code)),
		sets:
			m.sets.kind === "absent"
				? m.sets
				: {
						kind: "present",
						rows: Arr.map(m.sets.rows, (s) => Arr.filter(s, (code) => live.has(code)))
					}
	}
}

/** Two nonempty subsets of the nodes, in the nodes' order: closed rows, lawful or not. */
const closedRowsGen: Gen<ClosedRows> = (source) => ({
	allowed: nonEmpty(
		source.draw(subset(nodeHandles, { min: 1, max: nodeHandles.length })),
		"Allowed's nodes"
	),
	from: nonEmpty(
		source.draw(subset(nodeHandles, { min: 1, max: nodeHandles.length })),
		"Edge's nodes"
	)
})

/** Whether the closed rows keep the closed-only law: every node an edge leaves from is allowed. */
const lawful = (rows: ClosedRows): boolean => Arr.every(rows.from, (n) => rows.allowed.includes(n))

/** The machine over the model, its roster commands A8's. */
export const machine = (initial: Model): Machine<Model, Params, Refusal> => ({
	initial,
	commands: {
		grow: {
			weight: 1,
			applies: (m) => rosterCommands(m.tier).grow.applies(m.tier),
			parameters: (m) => rosterCommands(m.tier).grow.parameters(m.tier),
			judge: (m, p) => {
				const v = rosterCommands(m.tier).grow.judge(m.tier, p)
				return v.kind === "accepted" ? accepted(withTier(m, v.next)) : v
			}
		},
		remove: {
			weight: 3,
			applies: (m) => rosterCommands(m.tier).remove.applies(m.tier),
			parameters: (m) => (source) => ({
				...source.draw(rosterCommands(m.tier).remove.parameters(m.tier)),
				data: source.draw(element(dataSteps)),
				drop: source.draw(element(dropDeclarations))
			}),
			judge: (m, p) => {
				if (p.drop === "undeclared") {
					return refused("undeclared")
				}
				const v = rosterCommands(m.tier).remove.judge(m.tier, { handle: p.handle })
				return v.kind === "accepted" ? accepted(withTier(m, v.next)) : v
			}
		},
		readd: {
			weight: 1,
			applies: (m) => rosterCommands(m.tier).readd.applies(m.tier),
			parameters: (m) => rosterCommands(m.tier).readd.parameters(m.tier),
			judge: (m, p) => {
				const v = rosterCommands(m.tier).readd.judge(m.tier, p)
				return v.kind === "accepted" ? accepted(withTier(m, v.next)) : v
			}
		},
		reorder: {
			weight: 1,
			applies: (m) => rosterCommands(m.tier).reorder.applies(m.tier),
			parameters: (m) => rosterCommands(m.tier).reorder.parameters(m.tier),
			judge: () => refused("reordered")
		},
		write: {
			weight: 2,
			applies: () => true,
			parameters: (m) => map(liveHandleGen(m.tier), (handle) => ({ handle })),
			judge: (m, p) =>
				accepted({ ...m, held: [...m.held, defined(codeAt(m.tier, p.handle), "a live handle")] })
		},
		"add sets": {
			weight: 1,
			applies: (m) => m.sets.kind === "absent",
			parameters: () => constant({}),
			judge: (m) => accepted({ ...m, sets: { kind: "present", rows: [] } })
		},
		"write set": {
			weight: 2,
			applies: (m) => m.sets.kind === "present",
			parameters: (m) => map(liveSubsetGen(m.tier), (members) => ({ members })),
			judge: (m, p) =>
				m.sets.kind === "absent"
					? accepted(m)
					: accepted({
							...m,
							sets: {
								kind: "present",
								rows: [
									...m.sets.rows,
									Arr.map(p.members, (h) => defined(codeAt(m.tier, h), "a live handle"))
								]
							}
						})
		},
		regenerate: {
			weight: 1,
			applies: () => true,
			parameters: () => constant({}),
			judge: (m) => accepted(m)
		},
		"closed rows": {
			weight: 1,
			applies: () => true,
			parameters: () => closedRowsGen,
			judge: (m, p) => (lawful(p) ? accepted({ ...m, closedRows: p }) : refused("law"))
		}
	}
})

/** A model's built version: its schema value and login, its two roles, and the closed-only law. */
export interface Built {
	readonly version: Version
	readonly writer: AnyRole
	readonly reader: AnyRole
	readonly law: ReturnType<typeof contained>
}

/**
 * The model as a schema under `name`, the roster declared as `declaration`: Tier and Node; Allowed and Edge, closed
 * relations over Node under the closed-only law; Held, an id and a Tier; Sets, an id and a set over Tier, once added;
 * `writer` writing Held and Sets whole, `reader` reading them, both of the one login `desk`.
 */
export const builtOf = (name: string, m: Model, declaration: Declaration): Built => {
	const Tier = closedBuilder(m.tier.closed, declaration, "ordered", [])
	const Node = closed.ordered("Node", nodeHandles)
	const Allowed = closed.relation(
		"Allowed",
		{ node: closedId(Node) },
		["node"],
		Arr.map(m.closedRows.allowed, (node) => ({ node }))
	)
	const Edge = closed.relation(
		"Edge",
		{ from: closedId(Node), to: closedId(Node) },
		["from", "to"],
		Arr.map(m.closedRows.from, (node) => ({ from: node, to: node }))
	)
	const law = contained(on(Edge, "from"), on(Allowed, "node"))
	const Held = relation("Held", { id: pg.integer, tier: closedId(Tier) }, ["id"])
	const stored: Record<string, AnyRelation> = { Held }
	if (m.sets.kind === "present") {
		stored["Sets"] = relation("Sets", { id: pg.integer, members: bits(Tier) }, ["id"])
	}
	const declared: Record<string, AnyRelation | AnyClosed> = { Tier, Node, Allowed, Edge, ...stored }
	const base = schema(name, Rec.values(declared), [law])
	const writer = role(base, "writer", stored, { write: Rec.keys(stored) })
	const reader = role(base, "reader", stored, { write: [] })
	return {
		version: { schema: base, logins: [login(base, "desk", [writer, reader])] },
		writer,
		reader,
		law
	}
}

/** The model a case starts from: the drawn roster, no rows, no Sets, every node allowed and one edge. */
export const initialOf = (tier: RosterState): Model => ({
	tier,
	held: [],
	sets: { kind: "absent" },
	closedRows: { allowed: nodeHandles, from: ["North"] }
})

/** A case: the roster installed, and the program run after it. */
interface Run {
	readonly installed: RosterState
	readonly program: Program<Params>
}

/**
 * The situations the steered phase aims a case at, each by a program that reaches it (aimedProgram): every required one,
 * since most need several commands in order, which a drawn program meets only by chance. The generator aims a case at
 * the one its turn falls on (runGen), so no situation waits behind another its program does not reach.
 */
const aimedFeatures = [
	"a handle grown",
	"a handle removed",
	"a removed name declared again",
	"a reorder refused",
	"nothing drafted",
	"closed rows changed",
	"VALIDATE refused a removed code a row holds",
	"VALIDATE refused a removed bit a set holds",
	"a data step drafted",
	"a set column widened",
	"an undeclared drop refused",
	"closed rows refused by their law"
] as const satisfies ReadonlyArray<Feature>

/**
 * A program that reaches `feature` from `initial`, for the generator to aim a case at a situation that needs several
 * commands in order (runGen): a row or a set written before its handle's removal, Sets added before the roster grows,
 * closed rows that break their law. Every step is one the machine applies there, and the system is still judged step by
 * step against the model; a grown handle's fresh name is drawn.
 */
const aimedProgram =
	(feature: (typeof aimedFeatures)[number], initial: Model): Gen<Program<Params>> =>
	(source) => {
		const handle = Arr.headNonEmpty(liveOf(initial.tier))
		const remove = (data: DataStep, drop: DropDeclaration) =>
			({ command: "remove", parameters: { handle, data, drop } }) as const
		switch (feature) {
			case "a handle grown":
				return [
					{
						command: "grow",
						parameters: source.draw(rosterCommands(initial.tier).grow.parameters(initial.tier))
					}
				]
			case "a handle removed":
				return [remove("drafted", "declared")]
			case "a removed name declared again":
				return [remove("drafted", "declared"), { command: "readd", parameters: { handle } }]
			case "a reorder refused":
				return [{ command: "reorder", parameters: { first: 0, second: 1 } }]
			case "nothing drafted":
				return [{ command: "regenerate", parameters: {} }]
			case "closed rows changed":
				return [
					{ command: "closed rows", parameters: { allowed: ["North", "South"], from: ["South"] } }
				]
			case "VALIDATE refused a removed code a row holds":
				return [{ command: "write", parameters: { handle } }, remove("after a refusal", "declared")]
			case "VALIDATE refused a removed bit a set holds":
				return [
					{ command: "add sets", parameters: {} },
					{ command: "write set", parameters: { members: [handle] } },
					remove("after a refusal", "declared")
				]
			case "a data step drafted":
				return [{ command: "write", parameters: { handle } }, remove("drafted", "declared")]
			case "a set column widened":
				return [
					{ command: "add sets", parameters: {} },
					{
						command: "grow",
						parameters: source.draw(rosterCommands(initial.tier).grow.parameters(initial.tier))
					}
				]
			case "an undeclared drop refused":
				return [remove("drafted", "undeclared")]
			case "closed rows refused by their law":
				return [{ command: "closed rows", parameters: { allowed: ["North"], from: ["South"] } }]
		}
	}

/**
 * A drawn program from `initial`: a swarm over the commands with `write`, which applies in every state, kept on (the
 * all-off draw's guard), and a program of one to six steps from the swarm.
 */
const programGen =
	(initial: Model): Gen<Program<Params>> =>
	(source) => {
		const drawnSwarm = source.draw(swarm(nonEmpty(commandNames, "the commands")))
		const guarded: Swarm<keyof Params> = { ...drawnSwarm, write: drawnSwarm.write ?? 1 }
		return source.draw(program(machine(initial), { min: 1, max: 6 }, guarded))
	}

/**
 * A case as the generator draws it: the roster, and the program run after it, which is the program that reaches the
 * situation of aimedFeatures the case's turn aims at (Steered, aimedProgram), and otherwise a drawn one (programGen).
 */
export const runGen: Steered<Run, Feature>["under"] = (steering) => (source) => {
	const installed = source.draw(installedGen(tierName, { min: 2, max: 4 }))
	const initial = initialOf(installed)
	return {
		installed,
		program: source.draw(
			Option.match(
				Option.flatMap(steering, (pending) =>
					Arr.findFirst(aimedFeatures, (f) => pending.aimed(f))
				),
				{
					onNone: () => programGen(initial),
					onSome: (feature) => aimedProgram(feature, initial)
				}
			)
		)
	}
}

/** The real system a program runs against: the first installation, and what the migrations after it reached. */
export interface System {
	readonly m: Migrated
	readonly writer: RawSession
	readonly first: Built
	snapshot: DeploySnapshot
	/** The physical names of the version the snapshot is of: each migration's own installation's. */
	names: PhysicalNames
	folders: Array<FolderTexts>
	/** The folders the history holds, its installed ones and those drafted after them: the next draft is drafted at the
	 * ordinal past their count on the tests' one clock (migrate/kit.ts draftedAt), so it sorts after every one of them. */
	drafts: number
	ids: number
	constants: Map<string, { readonly name: string; readonly bits: string }>
}

/** The installation a case migrates: the first version installed, with its owner's session. */
type Migrated = Effect.Success<ReturnType<typeof migrated>>

/** What a real step fails with: a statement of the harness, or a migration the model says applies. */
type StepError = SqlError | MigrateError | TransactionRolledBack

/** Handles in one order, so two sets compare as sets. */
const sortedHandles = (handles: Iterable<string>): ReadonlyArray<string> =>
	Arr.sort(Arr.fromIterable(handles), Order.String)

/** A decoded set's handles in one order; a value of another carrier fails the test. */
const membersOf = (value: unknown): ReadonlyArray<string> => {
	if (!(value instanceof Set)) {
		return assert.fail("a set column decodes to a Set")
	}
	return sortedHandles(Arr.map(Arr.fromIterable(value), String))
}

/** The model's names of a roster's codes, a hole the empty name. */
const modelNames = (state: RosterState): ReadonlyArray<string> =>
	Arr.map(state.slots, (slot) => (slot.kind === "live" ? slot.handle : ""))

/** The Node roster as the model holds it: every handle live, never changed. */
const nodeState: RosterState = {
	closed: parsedName("Node"),
	slots: [
		{ kind: "live", handle: "North" },
		{ kind: "live", handle: "South" },
		{ kind: "live", handle: "East" }
	],
	spellings: { plain: 3 }
}

/** The next draft from the system's snapshot to `built`, its codes drafted from that snapshot's, reviewed by `reviewer`. */
const draftNext = (sys: System, built: Built, reviewer: Reviewer, declared: Declarations) =>
	Effect.gen(function* () {
		const { drafted, names } = yield* drafting(sys, built, declared)
		const g = succeeded(drafted, "the next migration")
		return { g, folder: reviewedSource(g, reviewer), names }
	})

/**
 * The next draft from the system's snapshot to `built`, declaring `declared`: generate's answer, a refusal included,
 * and the physical names of the installation it drafts.
 */
const drafting = (sys: System, built: Built, declared: Declarations) =>
	Effect.sync(() => {
		const owned = succeeded(
			own(defined(schemaDescOf(built.version.schema), "a version's schema value"))
		)
		const rosters = rostersOf(owned)
		const codes = succeeded(
			draftCodebook(
				rosterFates(
					sys.snapshot,
					declared,
					Arr.map(rosters, (r) => r.closed)
				),
				noRenames,
				rosters,
				spellingsOf(sys.snapshot)
			),
			"a drafted version keeps every roster's codes in order"
		)
		const workload = workloadOf(built.version)
		const plan = succeeded(
			planRealInstall(built.version.schema, {
				installation: identity.schema(parsedSchemaName(sys.m.declared)),
				logins: built.version.logins,
				extensions: workload.extensions,
				codes,
				compile: compileInstallation
			}),
			"the installation of the next version"
		)
		sys.drafts += 1
		const drafted: EngineResult.Result<GenerateResult, CompileError> = generate({
			previous: fromSnapshot(sys.snapshot),
			installation: plan.installation,
			name: `step_${sys.drafts}`,
			timestamp: draftedAt(sys.drafts),
			workload: workload.draft,
			declared
		})
		return { drafted, names: plan.installation.names }
	})

/** Applies the system's folders and then `next`, as the installation's owner login. */
const applyWith = (sys: System, next: ReadonlyArray<FolderTexts>, snapshot: DeploySnapshot) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, sys.m.ambientOwner.credentials)
		return yield* apply(
			migrator,
			{ snapshot, folders: [...sys.m.folders, ...sys.folders, ...next] },
			noFurther
		)
	})

/** The failure an apply met, or undefined when it applied. */
const failureOf = <A, R>(effect: Effect.Effect<A, MigrateError, R>) =>
	Effect.match(effect, {
		onSuccess: (): MigrateError | undefined => undefined,
		onFailure: (e) => e
	})

/** The server's report of a failed migration. */
const serverOf = (e: MigrateError) => {
	const server = e.server
	if (server.by !== "server") {
		return assert.fail(`the server reports the failure: ${e.message}`)
	}
	return server.error
}

/**
 * Held and Sets as SQL text. Sets' names are read only when a caller reads them, since an installation holds Sets only
 * after a command adds it, and the installed names refuse a relation the installation lacks.
 */
const storedNames = (sys: System) => ({
	held: printObjectName(sys.names.relation("Held")),
	heldId: quoteIdent(sys.names.column("Held", "id")),
	tier: quoteIdent(sys.names.column("Held", "tier")),
	get sets() {
		return printObjectName(sys.names.relation("Sets"))
	},
	get setsId() {
		return quoteIdent(sys.names.column("Sets", "id"))
	},
	get members() {
		return quoteIdent(sys.names.column("Sets", "members"))
	}
})

/** The drop a removal of `handle` declares, `--drop <roster>#<handle>`. */
const dropOf = (before: Model, handle: string): Declarations => ({
	renames: [],
	drops: [{ kind: "handle", roster: before.tier.closed, handle }]
})

/** The model with `handle` removed from its roster, as the removal declares it. */
const withoutHandle = (before: Model, handle: string): Model => {
	const v = rosterCommands(before.tier).remove.judge(before.tier, { handle })
	return v.kind === "accepted" ? withTier(before, v.next) : before
}

/** The columns a removal's VALIDATE must name: Held's where a row holds the code, Sets' where a set holds it. */
const holdersOf = (sys: System, before: Model, code: number) => [
	...(before.held.includes(code)
		? [{ table: sys.names.relation("Held").name, column: sys.names.column("Held", "tier") }]
		: []),
	...(before.sets.kind === "present" && Arr.some(before.sets.rows, (s) => s.includes(code))
		? [{ table: sys.names.relation("Sets").name, column: sys.names.column("Sets", "members") }]
		: [])
]

/**
 * The data step of a removal, each statement on its own: Held's rows holding the code deleted, and the code's bit
 * cleared from every set by the mask of the roster's live codes after it, each row deleted and inserted again, as an
 * immutable relation's rows change: its guard refuses an UPDATE outside a migration's bracketed data steps
 * (physical/ddl/immutable.ts guardBracket), and a step a person runs between a refused migration's attempts is outside
 * them.
 */
const dataStepOf = (sys: System, after: Model, code: number, column: string): string => {
	const n = storedNames(sys)
	return column === sys.names.column("Held", "tier")
		? `DELETE FROM ${n.held} WHERE ${n.tier} = ${code}::smallint;`
		: `WITH gone AS (DELETE FROM ${n.sets} RETURNING ${n.setsId}, ${n.members}) INSERT INTO ${n.sets} (${n.setsId}, ${n.members}) SELECT ${n.setsId}, ${n.members} & X'${hexOfText(setText(sizeOf(after.tier), liveCodes(after.tier)))}'::bit(${setWidth(sizeOf(after.tier))}) FROM gone;`
}

/** A closed id's and a set's type over the roster's live handles: the columns' codecs' types. */
const codeType = (state: RosterState): ScalarType =>
	scalarOf(
		{ kind: "closedId", roster: state.closed, only: undefined },
		{ [state.closed]: liveOf(state) }
	)

const setType = (state: RosterState): ScalarType =>
	scalarOf({ kind: "bits", roster: state.closed }, { [state.closed]: liveOf(state) })

/** The names each names constant of the schema holds, in subscript order: every function of it returning name[]. */
const namesConstantsOf = (owner: RawSession, schema: string) =>
	Effect.gen(function* () {
		const rows = yield* owner.values(
			`SELECT n.nspname::text, p.proname::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1::text AND p.prorettype = 'pg_catalog.name[]'::regtype`,
			[schema]
		)
		return yield* Effect.forEach(rows, (row) =>
			Effect.gen(function* () {
				const [schemaName, name] = trusted<readonly [string, string]>(row)
				const held = yield* owner.values(
					`SELECT u.n::text FROM pg_catalog.unnest(${quoteIdent(schemaName)}.${quoteIdent(name)}()) WITH ORDINALITY AS u(n, i) ORDER BY u.i`,
					[]
				)
				return Arr.map(held, (r) => String(r[0]))
			})
		)
	})

/**
 * The installation is the model's: each roster's domain reads one live-codes constant, holding the model's live codes,
 * renamed exactly when they change; the schema's names constants hold exactly each roster's names in code order, every
 * replaced one dropped; Held's codes and Sets' sets are the model's, and decode to the model's handles; Sets' column is
 * a domain over bit(n), n its codes rounded up to whole bytes.
 */
export const sameAsModel = (sys: System, after: Model) =>
	Effect.gen(function* () {
		const owner = sys.m.owner
		const rosters = [after.tier, nodeState]
		for (const state of rosters) {
			const live = yield* liveConstantOf(owner, sys.names.rosterDomain(state.closed))
			const bits = yield* liveHeld(owner, live.call)
			assert.equal(bits, modelLive(state), `the live-codes constant of ${state.closed}`)
			const was = sys.constants.get(state.closed)
			if (was !== undefined) {
				assert.equal(
					live.name === was.name,
					bits === was.bits,
					`the live-codes constant of ${state.closed} is renamed exactly when its live codes change`
				)
			}
			sys.constants.set(state.closed, { name: live.name, bits })
		}
		const names = yield* namesConstantsOf(owner, sys.m.schema)
		unorderedEqual(
			Arr.map(names, (held) => Arr.join(held, "\u0000")),
			Arr.map(rosters, (state) => Arr.join(modelNames(state), "\u0000")),
			"the schema's names constants hold exactly each roster's names in code order, every replaced one dropped"
		)
		const codes = codebookOf(sys.snapshot)
		const n = storedNames(sys)
		const held = yield* owner.values(
			`SELECT ${n.tier}::text FROM ${n.held} ORDER BY ${n.heldId}`,
			[]
		)
		const codec = scalarReader(codeType(after.tier), codes)
		assert.deepEqual(
			Arr.map(held, (r) => ({
				code: Number(r[0]),
				handle: codec.convert(outputText(String(r[0])))
			})),
			Arr.map(after.held, (code) => ({
				code,
				handle: defined(modelNames(after.tier)[code], "a live code's handle")
			})),
			"Held's rows hold the model's codes, each decoding to its handle"
		)
		if (after.sets.kind === "present") {
			const sets = yield* owner.values(
				`SELECT ${n.members}::text FROM ${n.sets} ORDER BY ${n.setsId}`,
				[]
			)
			const setCodec = scalarReader(setType(after.tier), codes)
			assert.deepEqual(
				Arr.map(sets, (r) => ({
					text: String(r[0]),
					members: membersOf(setCodec.convert(outputText(String(r[0]))))
				})),
				Arr.map(after.sets.rows, (s) => ({
					text: setText(sizeOf(after.tier), s),
					members: sortedHandles(Arr.map(s, (code) => defined(modelNames(after.tier)[code])))
				})),
				"Sets' bit strings are the model's sets, each decoding to its handles"
			)
			const type = yield* owner.values(
				`SELECT t.typtype::text, pg_catalog.format_type(t.typbasetype, t.typtypmod) FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid WHERE a.attrelid = $1::text::regclass AND a.attname = $2::text`,
				[n.sets, sys.names.column("Sets", "members")]
			)
			assert.deepEqual(
				Arr.map(type, (r) => [String(r[0]), String(r[1])]),
				[["d", `bit(${setWidth(sizeOf(after.tier))})`]],
				"Sets' column is a domain over bit(n), its codes rounded up to whole bytes"
			)
		}
	})

/** A migration to `after` the model accepts: drafted, reviewed by `reviewer`, applied, and judged against the model. */
const migrateTo = (sys: System, after: Model, reviewer: Reviewer) =>
	Effect.gen(function* () {
		const { g, folder, names } = yield* draftNext(
			sys,
			builtOf(sys.m.declared, after, liveOf(after.tier)),
			reviewer,
			noDeclarations
		)
		yield* applyWith(sys, [folder], g.snapshot)
		sys.folders.push(folder)
		sys.snapshot = g.snapshot
		sys.names = names
		yield* sameAsModel(sys, after)
		return took
	})

/** Whether a drafted step VALIDATEs a constraint: ALTER DOMAIN's VALIDATE CONSTRAINT, or an ALTER TABLE action of it. */
const validates = (d: Draft): boolean =>
	d.kind === "statement" &&
	((d.statement.kind === "alterDomain" && d.statement.action.kind === "validateConstraint") ||
		(d.statement.kind === "alterTable" &&
			Arr.some(d.statement.actions, (a) => a.kind === "validateConstraint")))

/**
 * A reviewer of `g` that drafts `statements` at the top of the file the plan puts its VALIDATE in, as a reviewer reads
 * the folder's phases, every candidate kept.
 */
const withDataStep = (g: GenerateResult, statements: ReadonlyArray<string>): Reviewer => {
	const validating = Arr.findFirst(planFiles(g.plan), (f) => Arr.some(f.drafts, validates))
	return {
		decisions: kept.decisions,
		edit: (file) =>
			Arr.isReadonlyArrayNonEmpty(statements) &&
			Option.exists(validating, (f) => f.name === file.name)
				? `${Arr.join(statements, "\n\n")}\n\n${file.text}`
				: kept.edit(file)
	}
}

/**
 * A removal: with the data step drafted, the migration applies; otherwise VALIDATE refuses it once per column that holds
 * the removed code, naming that column, each refusal followed by that column's data step, and then it applies. The
 * columns named are exactly the ones the model says hold it.
 */
const removal = (
	sys: System,
	p: Params["remove"],
	before: Model,
	after: Model,
	note: (f: Feature) => void
) =>
	Effect.gen(function* () {
		if (p.drop === "undeclared") {
			note("an undeclared drop refused")
			const { drafted } = yield* drafting(
				sys,
				builtOf(
					sys.m.declared,
					withoutHandle(before, p.handle),
					liveOf(withoutHandle(before, p.handle).tier)
				),
				noDeclarations
			)
			assert.ok(!drafted.ok, "a removal whose drop no declaration names drafts nothing")
			assert.deepEqual(
				drafted.error.reason._tag === "UndeclaredDrop" ? drafted.error.reason.dropped : undefined,
				{ kind: "handle", roster: before.tier.closed, handle: p.handle },
				"the refusal names the dropped handle"
			)
			sys.drafts -= 1
			yield* sameAsModel(sys, before)
			return refused("undeclared")
		}
		note("a handle removed")
		const code = defined(codeAt(before.tier, p.handle), "a live handle")
		const holders = holdersOf(sys, before, code)
		const built = builtOf(sys.m.declared, after, liveOf(after.tier))
		if (p.data === "drafted") {
			if (holders.length > 0) {
				note("a data step drafted")
			}
			const { drafted, names } = yield* drafting(sys, built, dropOf(before, p.handle))
			const g = succeeded(drafted, "the next migration")
			const folder = reviewedSource(
				g,
				withDataStep(
					g,
					Arr.map(holders, (h) => dataStepOf(sys, after, code, h.column))
				)
			)
			yield* applyWith(sys, [folder], g.snapshot)
			sys.folders.push(folder)
			sys.snapshot = g.snapshot
			sys.names = names
		} else {
			const { g, folder, names } = yield* draftNext(sys, built, kept, dropOf(before, p.handle))
			const named: Array<{ readonly table: string; readonly column: string }> = []
			let applied = false
			for (let attempt = 0; !applied && attempt <= holders.length; attempt += 1) {
				const failure = yield* failureOf(applyWith(sys, [folder], g.snapshot))
				if (failure === undefined) {
					applied = true
					continue
				}
				const server = serverOf(failure)
				assert.equal(server.sqlstate, sqlstates.checkViolation, failure.message)
				const at = {
					table: defined(server.table, "VALIDATE names the table"),
					column: defined(server.column, "VALIDATE names the column")
				}
				note(
					at.column === sys.names.column("Held", "tier")
						? "VALIDATE refused a removed code a row holds"
						: "VALIDATE refused a removed bit a set holds"
				)
				named.push(at)
				yield* sys.m.owner.query(dataStepOf(sys, after, code, at.column), [])
			}
			assert.ok(applied, "the removal applies once its data step ran")
			unorderedEqual(
				named,
				holders,
				"VALIDATE names exactly the columns that hold the removed code"
			)
			sys.folders.push(folder)
			sys.snapshot = g.snapshot
			sys.names = names
		}
		yield* sameAsModel(sys, after)
		return took
	})

/** A reorder: the draft is refused before anything is drafted, naming the pair the model names; nothing changes. */
const reordering = (sys: System, p: Params["reorder"], before: Model) =>
	Effect.gen(function* () {
		const declaration = declarationOf(before.tier, { command: "reorder", parameters: p })
		const owned = succeeded(
			own(
				defined(
					schemaDescOf(builtOf(sys.m.declared, before, declaration).version.schema),
					"a reordered version's schema value"
				)
			)
		)
		const rosters = rostersOf(owned)
		const drafted = draftCodebook(
			rosterFates(
				sys.snapshot,
				noDeclarations,
				Arr.map(rosters, (r) => r.closed)
			),
			noRenames,
			rosters,
			spellingsOf(sys.snapshot)
		)
		assert.ok(!drafted.ok, "a reordered roster drafts no codebook")
		assert.deepEqual(
			{ roster: drafted.error.roster, earlier: drafted.error.earlier, later: drafted.error.later },
			{
				roster: before.tier.closed,
				...defined(reorderedPair(before.tier, declaration), "the model's pair")
			},
			"the refusal names the pair the declaration puts out of their codes' order"
		)
		yield* sameAsModel(sys, before)
		return refused("reordered")
	})

/** Closed rows: a lawful change migrates; rows breaking the law fail with 23000 naming it, leaving nothing behind. */
const closedRowsStep = (sys: System, p: ClosedRows, before: Model, note: (f: Feature) => void) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const proposed: Model = { ...before, closedRows: p }
		if (lawful(p)) {
			note("closed rows changed")
			return yield* migrateTo(sys, proposed, kept)
		}
		note("closed rows refused by their law")
		const built = builtOf(sys.m.declared, proposed, liveOf(proposed.tier))
		const { g, folder } = yield* draftNext(sys, built, kept, noDeclarations)
		const catalogBefore = yield* readCatalog(substrate.admin, [sys.m.schema])
		const attempted = yield* failureOf(applyWith(sys, [folder], g.snapshot))
		const failure = defined(attempted, "closed rows that break the law fail the migration")
		const server = serverOf(failure)
		assert.deepEqual(
			{ sqlstate: server.sqlstate, constraint: server.constraint },
			{
				sqlstate: sqlstates.integrityConstraintViolation,
				constraint: lawIdOf(built.version.schema, built.law)
			},
			"the migration's violation query names the law"
		)
		const catalogAfter = yield* readCatalog(substrate.admin, [sys.m.schema])
		assert.deepEqual(
			catalogAfter,
			catalogBefore,
			"the refused migration leaves the catalog as it was"
		)
		yield* applyWith(sys, [], sys.snapshot)
		yield* sameAsModel(sys, before)
		return refused("law")
	})

/** Each command run on the real system. */
export const real = (
	sys: System,
	note: (f: Feature) => void
): Real<Model, Params, Refusal, StepError, Substrate | Scope.Scope> => ({
	grow: (_p, _before, after) => {
		note("a handle grown")
		if (after.sets.kind === "present") {
			note("a set column widened")
		}
		return migrateTo(sys, after, kept)
	},
	remove: (p, before, after) => removal(sys, p, before, after, note),
	readd: (_p, _before, after) => {
		note("a removed name declared again")
		return migrateTo(sys, after, kept)
	},
	reorder: (p, before) => {
		note("a reorder refused")
		return reordering(sys, p, before)
	},
	write: (p, before, after) =>
		Effect.gen(function* () {
			const n = storedNames(sys)
			yield* sys.writer.begin
			yield* sys.writer.query(
				`INSERT INTO ${n.held} (${n.heldId}, ${n.tier}) VALUES ($1::integer, $2::smallint)`,
				[sys.ids, defined(codeAt(before.tier, p.handle))]
			)
			yield* sys.writer.commit
			sys.ids += 1
			yield* sameAsModel(sys, after)
			return took
		}),
	"add sets": (_p, _before, after) => migrateTo(sys, after, kept),
	"write set": (p, before, after) =>
		Effect.gen(function* () {
			note("a set stored")
			const n = storedNames(sys)
			const text = succeeded(
				scalarCodec(setType(before.tier), codebookOf(sys.snapshot)).encode(new Set(p.members)),
				"a set of live handles"
			)
			assert.equal(
				text,
				paramText(
					`X${hexOfText(
						setText(
							sizeOf(before.tier),
							Arr.map(p.members, (h) => defined(codeAt(before.tier, h)))
						)
					)}`
				),
				"the host writes X and the hex digits of the model's positional text"
			)
			yield* sys.writer.begin
			yield* sys.writer.query(
				`INSERT INTO ${n.sets} (${n.setsId}, ${n.members}) VALUES ($1::integer, $2::text::bit(${setWidth(sizeOf(before.tier))}))`,
				[sys.ids, text]
			)
			yield* sys.writer.commit
			sys.ids += 1
			yield* sameAsModel(sys, after)
			return took
		}),
	regenerate: (_p, before) =>
		Effect.gen(function* () {
			note("nothing drafted")
			const { g } = yield* draftNext(
				sys,
				builtOf(sys.m.declared, before, liveOf(before.tier)),
				kept,
				noDeclarations
			)
			assert.deepEqual(
				{ change: g.change, files: g.folder.files.length, fingerprint: g.snapshot.fingerprint },
				{ change: "none", files: 0, fingerprint: sys.snapshot.fingerprint },
				"a draft with no change drafts nothing"
			)
			return took
		}),
	"closed rows": (p, before) => closedRowsStep(sys, p, before, note)
})
