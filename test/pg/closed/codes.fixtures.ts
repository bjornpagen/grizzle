/** What the properties of codes.test.ts read: the hole patterns, their probes and templates, and each case's judgment. */
import { type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int, steered, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { type MigrateError } from "#adapter/migrate/errors.ts"
import { type FolderTexts } from "#adapter/migrate/input.ts"
import type { Named } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type ConstraintName } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { type ParamText } from "#compiler/core/wire.ts"
import { type Declarations } from "#compiler/deploy/diff/plan.ts"
import { codebookOf } from "#compiler/deploy/snapshot/build.ts"
import { type DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { type Codebook } from "#compiler/ir/codes.ts"
import { type ScalarType } from "#compiler/ir/scalar.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { login } from "#compiler/program/workload/login.ts"
import { bits, closedId, pg } from "#compiler/public/fields.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type AnyRole,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { closedBuilder, relationBuilder } from "#compiler/schema/relation.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import { hexOfText, setText, setWidth } from "#test/support/closed/bit-text.ts"
import {
	ALIAS_CODE,
	codeAt,
	everyCode,
	holesOf,
	liveOf,
	type ModelSlot,
	patternHistory,
	type RosterFeature,
	type RosterState,
	sizeOf
} from "#test/support/closed/generate.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { draftVersion, type Installed } from "#test/support/install-migrate.ts"
import {
	migrated,
	migratedOnceTemplate,
	noObservation,
	type Version,
	workloadOf
} from "#test/support/installed.ts"
import { parsedName, parsedSchemaName, roleNamesOf } from "#test/support/kernel/naming.ts"
import { fromSnapshot, noDeclarations } from "#test/support/migrate/kit.ts"
import { type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { expectConstraint, inTransaction } from "#test/support/substrate/expect.ts"
import { type RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { paramText } from "#test/support/wire.ts"

/** The codes every hole pattern spans: a 5-code roster. */
const patternSize = 5

/** The names a pattern's codes hold, rotated by its mask. */
const patternNames = ["Open", "Done", "Held", "Gone", "Late"] as const

/** The pattern of `mask`: code c live under its rotated name when bit c of the mask is set, a hole remembering it if not. */
const patternOf = (mask: number): RosterState => {
	const slots = Arr.map(
		Arr.makeBy(patternSize, (code) => code),
		(code): ModelSlot => {
			const name = Arr.getUnsafe(patternNames, (code + mask) % patternSize)
			return ((mask >> code) & 1) === 1
				? { kind: "live", handle: name }
				: { kind: "hole", was: name }
		}
	)
	return {
		closed: parsedName(`Mask${mask}`),
		slots: nonEmpty(slots, "a pattern spans every code"),
		spellings: { plain: 3 }
	}
}

/** Every hole pattern of a 5-code roster, each with one live code at least: masks 1 … 31. */
export const patterns: NonEmptyReadonlyArray<RosterState> = nonEmpty(
	Arr.map(
		upTo(2 ** patternSize - 1, (i) => i + 1),
		patternOf
	),
	"the patterns"
)

/** The drops of the handles each pattern's history removes, as `--drop Roster#handle` declares them. */
export const holeDrops = (states: ReadonlyArray<RosterState>): Declarations => ({
	renames: [],
	drops: Arr.flatMap(states, (state) =>
		Arr.flatMap(state.slots, (slot): ReadonlyArray<Named> =>
			slot.kind === "hole" ? [{ kind: "handle", roster: state.closed, handle: slot.was }] : []
		)
	)
})

/** The relation that stores a pattern's codes. */
export const probeOf = (state: RosterState): string => `${state.closed}Probe`

/** The model's name of each code in code order, a hole the empty name: what the names constant must hold. */
export const modelNames = (state: RosterState): ReadonlyArray<string> =>
	Arr.map(state.slots, (slot) => (slot.kind === "live" ? slot.handle : ""))

/** A built version of the probes: its schema value and login, and the two roles over every probe. */
interface Probes {
	readonly version: Version
	readonly writer: AnyRole
	readonly reader: AnyRole
}

/**
 * The probes under the declared name `name`, one per roster of `states`: a relation of an integer id and the roster's
 * closed id, which `writer` writes whole and `reader` reads whole, both of the one login `desk`.
 */
export const probesOf = (name: string, states: ReadonlyArray<RosterState>): Probes => {
	const declared: Record<string, AnyRelation | AnyClosed> = {}
	const probes: Record<string, AnyRelation> = {}
	for (const state of states) {
		const roster = closedBuilder(state.closed, liveOf(state), "ordered", [])
		const probe = relationBuilder(
			probeOf(state),
			{ id: pg.integer, code: closedId(roster) },
			["id"],
			[]
		)
		declared[state.closed] = roster
		declared[probeOf(state)] = probe
		probes[probeOf(state)] = probe
	}
	const base = schema(name, Rec.values(declared), [])
	const writer = role(base, "writer", probes, { write: Rec.keys(probes), refresh: [] })
	const reader = role(base, "reader", probes, { write: [], refresh: [] })
	return {
		version: { schema: base, logins: [login(base, "desk", [writer, reader])] },
		writer,
		reader
	}
}

/** The domain a roster's codes are typed by, as the installation names it. */
export const domainOf = (m: Installed, state: RosterState) => m.names.rosterDomain(state.closed)

/** The roster domain's one CHECK, as the naming door names it. */
const checkOf = (state: RosterState): ConstraintName =>
	identifierOf(identity.domainCheck(identity.rosterDomain(state.closed)))

/** A role view's decoded column of the field `code`, quoted. */
export const decodedColumn = quoteIdent(identifierOf(identity.decodedColumn(parsedName("code"))))

/** A pattern's probe table and its columns, quoted for SQL text. */
export const probeTable = (m: Installed, state: RosterState) => ({
	table: printObjectName(m.names.relation(probeOf(state))),
	id: quoteIdent(m.names.column(probeOf(state), "id")),
	code: quoteIdent(m.names.column(probeOf(state), "code"))
})

/** A direct writer's INSERT of one probe row, its id and its code bound as text. */
export const insertCode = (m: Installed, state: RosterState): string => {
	const p = probeTable(m, state)
	return `INSERT INTO ${p.table} (${p.id}, ${p.code}) VALUES ($1::integer, $2::smallint)`
}

/** A closed id's type over the roster's live handles: the column's codec's type. */
export const codeType = (state: RosterState): ScalarType =>
	scalarOf(
		{ kind: "closedId", roster: state.closed, only: undefined },
		{ [state.closed]: liveOf(state) }
	)

/**
 * The function a domain's CHECK depends on, by pg_depend: its schema, its name and the facts a names constant must
 * have. A CHECK that depends on other than one function is a failure of (8).
 */
export const constantOf = (
	session: RawSession,
	domain: { readonly schema: string; readonly name: string }
) =>
	Effect.gen(function* () {
		const rows = yield* session.values(
			`SELECT n.nspname::text, p.proname::text, p.pronargs::text, p.provolatile::text, p.prokind::text, p.prosecdef::text, (p.proconfig IS NULL)::text, p.prorettype::regtype::text FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_depend AS d ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_catalog.pg_proc'::regclass JOIN pg_catalog.pg_proc AS p ON p.oid = d.refobjid JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE c.contypid = $1::text::regtype`,
			[printObjectName(domain)]
		)
		assert.equal(rows.length, 1, `the CHECK of ${domain.name} depends on one function`)
		const [schemaName, name, args, volatility, kind, definer, unset, returns] = trusted<
			readonly [string, string, string, string, string, string, string, string]
		>(defined(rows[0]))
		assert.deepEqual(
			{ args, volatility, kind, definer, unset, returns },
			{
				args: "0",
				volatility: "i",
				kind: "f",
				definer: "false",
				unset: "true",
				returns: "name[]"
			},
			`the names constant of ${domain.name}`
		)
		return { call: `${quoteIdent(schemaName)}.${quoteIdent(name)}()`, schema: schemaName, name }
	})

/** The names constant's elements in subscript order, and its lower bound: what the domain and the view read. */
export const namesHeld = (session: RawSession, call: string) =>
	Effect.gen(function* () {
		const bounds = yield* session.values(
			`SELECT pg_catalog.array_lower(${call}, 1)::text, pg_catalog.cardinality(${call})::text`,
			[]
		)
		const rows = yield* session.values(
			`SELECT u.n::text FROM pg_catalog.unnest(${call}) WITH ORDINALITY AS u(n, i) ORDER BY u.i`,
			[]
		)
		return {
			lower: String(defined(bounds[0])[0]),
			cardinality: Number(defined(bounds[0])[1]),
			names: Arr.map(rows, (r) => String(r[0]))
		}
	})

/** A migration of the installed `m` from `previous` to `version`, drafted as `grizzle generate` drafts it and reviewed. */
export interface Drafted {
	readonly plan: RealInstallPlan
	readonly snapshot: DeploySnapshot
	readonly folder: FolderTexts
	readonly codes: Codebook
}

/**
 * The next migration of `m`, from the snapshot `previous` to `version`, as the `ordinal`-th folder of its history,
 * declaring `declared`, drafted as every history drafts a version (install-migrate.ts draftVersion), at its step's
 * instant after the installation's own folder, and reviewed with every loss written in, '0' for each placeholder; its
 * codes the codebook of the snapshot it reaches.
 */
export const draftNext = (
	m: Installed,
	previous: DeploySnapshot,
	version: Version,
	ordinal: number,
	declared: Declarations
) =>
	Effect.map(
		Effect.orDie(
			draftVersion(
				{
					version: { schema: version.schema, logins: version.logins, declarations: declared },
					workload: workloadOf(version)
				},
				{
					installation: identity.schema(parsedSchemaName(m.declared)),
					previous: fromSnapshot(previous),
					step: ordinal - 1
				},
				{
					extensions: [],
					compile: compileInstallation,
					review: { kind: "values", value: () => "'0'" }
				}
			)
		),
		(drafted): Drafted => ({
			plan: drafted.plan,
			snapshot: drafted.snapshot,
			folder: drafted.folder,
			codes: codebookOf(drafted.snapshot)
		})
	)

/** Applies `m`'s folders and then `next` as `m`'s owner login, the runner's MigrateError its failure. */
export const applyNext = (m: Installed, next: ReadonlyArray<Drafted>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
		const last = Arr.last(next)
		return yield* apply(
			migrator,
			{
				snapshot: Option.isSome(last) ? last.value.snapshot : m.snapshot,
				folders: [...m.folders, ...Arr.map(next, (d) => d.folder)]
			},
			noFurther
		)
	})

/** The first version of `states` installed alone, through its first migration, under a unique name. */
export const installFirst = <B>(
	label: string,
	build: (name: string) => B & { readonly version: Version }
) =>
	Effect.gen(function* () {
		const built: Array<B & { readonly version: Version }> = []
		const m = yield* migrated({
			label,
			schemaName: { kind: "unique" },
			first: (name) => {
				const b = build(name)
				built.push(b)
				return b.version
			},
			later: [],
			apply: { kind: "noPlaceholders" },
			declared: () => noDeclarations,
			observe: noObservation
		})
		return { m, first: defined(built[0], "the first version") }
	})

/** A writer's session in `role`'s world of `m`. */
export const sessionOf = (m: Installed, world: AnyRole, label: string) =>
	Effect.flatMap(Substrate, (substrate) =>
		substrate.session({ ...worldSession(m.world(world)), label })
	)

/** What a direct writer's code is, by the model: a live handle's, or the named cause the domain refuses it for. */
type CodeCause = "below" | "past" | "hole" | "alias"

export type CodeFeature = RosterFeature | CodeCause

export const causeOf = (state: RosterState, code: number): CodeCause =>
	code < 0 ? "below" : code === ALIAS_CODE ? "alias" : code >= sizeOf(state) ? "past" : "hole"

/** The roles that use a roster's codes: one stores them, one decodes them. */
const grantees = ["writer", "reader"] as const

export type Grantee = (typeof grantees)[number]

/** Notes a feature the case reached, or both of a pair and the pair. */
export const noteReached = (
	kase: {
		readonly note: (f: CodeFeature) => void
		readonly pair: (a: CodeFeature, b: CodeFeature) => void
	},
	reached: CodeFeature | readonly [CodeFeature, CodeFeature]
): void => {
	if (typeof reached === "string") {
		kase.note(reached)
		return
	}
	kase.note(reached[0])
	kase.note(reached[1])
	kase.pair(reached[0], reached[1])
}

/** One case of (2): a pattern, and one of its codes from −1 to size or 400, with the live handle the model gives it. */
interface CodeCase {
	readonly state: RosterState
	readonly code: number
	readonly live: string | undefined
}

/** Every pattern and every code of it the domain is judged on: 31 patterns times 8 codes. */
export const codeCaseGen: Gen<CodeCase> = (source) => {
	const state = source.draw(element(patterns))
	const entry = source.draw(element(nonEmpty(everyCode(state), "every roster has a code below 0")))
	return { state, code: entry.code, live: entry.live }
}

/**
 * The verdict on `c` in `session`, inside a transaction rolled back after it, so a case leaves no row and replays the
 * same: a live code is stored; any other is refused with 23514 on the roster domain's CHECK, the domain its data type.
 */
export const judgeCode = (m: Installed, session: RawSession, c: CodeCase) =>
	c.live === undefined
		? Effect.gen(function* () {
				const fields = yield* expectConstraint(
					inTransaction(session, session.query(insertCode(m, c.state), [1, c.code])),
					checkOf(c.state),
					"23514"
				)
				yield* session.rollback
				const domain = domainOf(m, c.state)
				assert.deepEqual(
					{ dataType: fields.dataType, schema: fields.schema },
					{ dataType: Option.some(domain.name), schema: Option.some(domain.schema) },
					`code ${c.code} of ${c.state.closed} is refused by its domain`
				)
			})
		: Effect.gen(function* () {
				yield* session.begin
				yield* session.query(insertCode(m, c.state), [1, c.code])
				yield* session.rollback
			})

/** The server's report of a migration's failure, which a test of a refused migration requires. */
export const serverOf = (e: MigrateError) => {
	const server = e.server
	if (server.by !== "server") {
		return assert.fail(`the server reports the failure: ${e.message}`)
	}
	return server.error
}

/** A bits relation's version: roster G of `handles`, Sets of an id and a set over G, written by `writer`. */
export const setsOf = (name: string, state: RosterState) => {
	const roster = closedBuilder(state.closed, liveOf(state), "ordered", [])
	const Sets = relation("Sets", { id: pg.integer, members: bits(roster) }, ["id"])
	const declared: Record<string, AnyRelation | AnyClosed> = { [state.closed]: roster, Sets }
	const base = schema(name, Rec.values(declared), [])
	const writer = role(base, "writer", { Sets }, { write: ["Sets"], refresh: [] })
	const reader = role(base, "reader", { Sets }, { write: [], refresh: [] })
	const version: Version = { schema: base, logins: [login(base, "desk", [writer, reader])] }
	return { version, writer, reader }
}

/** A set's type over the roster's live handles: the column's codec's type. */
export const setType = (state: RosterState): ScalarType =>
	scalarOf({ kind: "bits", roster: state.closed }, { [state.closed]: liveOf(state) })

/** Handles in one order, so two sets compare as sets. */
export const sortedHandles = (handles: Iterable<string>): ReadonlyArray<string> =>
	Arr.sort(Arr.fromIterable(handles), Order.String)

/** A decoded set's handles in one order; a value of another carrier fails the test. */
export const membersOf = (value: unknown): ReadonlyArray<string> => {
	if (!(value instanceof Set)) {
		return assert.fail("a set column decodes to a Set")
	}
	return sortedHandles(Arr.map(Arr.fromIterable(value), String))
}

/** Every subset of the roster's live handles, in code order: every set a bits value can be. */
export const subsetsOf = (state: RosterState): ReadonlyArray<ReadonlyArray<string>> => {
	const none: ReadonlyArray<ReadonlyArray<string>> = [[]]
	return Arr.reduce(liveOf(state), none, (sets, handle) => [
		...sets,
		...Arr.map(sets, (s) => [...s, handle])
	])
}

/** The model's text of a set: position c is 1 exactly when the set holds code c's handle, every padding bit 0. */
export const modelText = (state: RosterState, members: ReadonlyArray<string>): string =>
	setText(
		sizeOf(state),
		Arr.map(members, (h) => defined(codeAt(state, h), `${h} is live`))
	)

/** The model's wire text of a set: X, then the hex digits of its positional text. */
export const wireText = (state: RosterState, members: ReadonlyArray<string>): ParamText =>
	paramText(`X${hexOfText(modelText(state, members))}`)

/** The type of a column as the catalog holds it: its own type's kind, and its base type formatted with its typmod. */
export const columnTypeOf = (session: RawSession, table: string, column: string) =>
	Effect.gen(function* () {
		const rows = yield* session.values(
			`SELECT t.typtype::text, pg_catalog.format_type(t.typbasetype, t.typtypmod), n.nspname::text, t.typname::text FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace WHERE a.attrelid = $1::text::regclass AND a.attname = $2::text`,
			[table, column]
		)
		const [kind, base, schemaName, name] = trusted<readonly [string, string, string, string]>(
			defined(rows[0], `${table}.${column} exists`)
		)
		return { kind, base, domain: { schema: schemaName, name } }
	})

/** The one CHECK of a domain, by the catalog. */
export const domainCheckOf = (
	session: RawSession,
	domain: { readonly schema: string; readonly name: string }
) =>
	Effect.gen(function* () {
		const rows = yield* session.values(
			`SELECT c.conname::text FROM pg_catalog.pg_constraint AS c WHERE c.contypid = $1::text::regtype AND c.contype = 'c'`,
			[printObjectName(domain)]
		)
		assert.equal(rows.length, 1, `${domain.name} carries one CHECK`)
		return trusted<ConstraintName>(String(defined(rows[0])[0]))
	})

/** A roster of a VALIDATE case: a hole pattern, and the codes of its installation its rows hold, in code order. */
interface HeldRoster {
	readonly state: RosterState
	readonly held: ReadonlyArray<number>
}

/** One to four hole patterns, each with a subset of its five installed codes held by a row. */
interface ValidateCase {
	readonly rosters: ReadonlyArray<HeldRoster>
}

export const validateCaseGen: Gen<ValidateCase> = (source) => ({
	rosters: Arr.map(source.draw(subset(patterns, { min: 1, max: 4 })), (state) => ({
		state,
		held: source.draw(
			subset(
				Arr.makeBy(patternSize, (code) => code),
				{ min: 0, max: patternSize }
			)
		)
	}))
})

export type ValidateFeature =
	| "a table holding a removed code named"
	| "a table of holes holding only live codes"
	| "two tables named in turn"

export const validateFeatures = (
	c: ValidateCase,
	named: number
): ReadonlyArray<ValidateFeature> => [
	...(named > 0 ? ["a table holding a removed code named" as const] : []),
	...(named > 1 ? ["two tables named in turn" as const] : []),
	...(Arr.some(
		c.rosters,
		(r) =>
			holesOf(r.state).length > 0 && Arr.every(r.held, (code) => !holesOf(r.state).includes(code))
	)
		? ["a table of holes holding only live codes" as const]
		: [])
]

/** The names a bits history's handles take, in the order a growth adds them, never one again. */
const bitsNames = ["Open", "Done", "Held", "Gone", "Late", "Kept", "Lost"] as const

/** A migration of a bits history: one handle added after the last code, or one live handle removed. */
type BitsStep = { readonly kind: "grow" } | { readonly kind: "remove"; readonly handle: string }

/** A roster's history: its installation, then its migrations. */
interface BitsHistory {
	readonly installed: RosterState
	readonly steps: ReadonlyArray<BitsStep>
}

/** The state a step leads to: a growth appends the next name live, a removal leaves its code a hole. */
export const stepped = (state: RosterState, step: BitsStep): RosterState => {
	switch (step.kind) {
		case "grow":
			return {
				...state,
				slots: [
					...state.slots,
					{ kind: "live", handle: defined(bitsNames[state.slots.length], "a name to grow by") }
				]
			}
		case "remove":
			return {
				...state,
				slots: nonEmpty(
					Arr.map(state.slots, (slot): ModelSlot =>
						slot.kind === "live" && slot.handle === step.handle
							? { kind: "hole", was: slot.handle }
							: slot
					),
					"a roster's codes"
				)
			}
	}
}

/** The roster of a bits history's installation: its first `size` names, each live. */
const installedOf = (size: number): RosterState => ({
	closed: parsedName("Flags"),
	slots: nonEmpty(
		Arr.map(Arr.take(bitsNames, size), (handle): ModelSlot => ({ kind: "live", handle })),
		"an installation's handles"
	),
	spellings: { plain: 3 }
})

/** A migration of `state`: a removal of one live handle, drawn only beside another live handle, or a growth. */
const bitsStepGen =
	(state: RosterState): Gen<BitsStep> =>
	(source) => {
		const live = liveOf(state)
		return live.length > 1 && source.draw(element(["grow", "remove"] as const)) === "remove"
			? { kind: "remove", handle: source.draw(element(live)) }
			: { kind: "grow" }
	}

/** A history of `installed` through the steps `taken`, then `more` migrations drawn after them. */
const bitsHistoryFrom =
	(installed: RosterState, taken: ReadonlyArray<BitsStep>, more: Gen<number>): Gen<BitsHistory> =>
	(source) => {
		const steps = [...taken]
		let state = Arr.reduce(taken, installed, stepped)
		const count = source.draw(more)
		for (let at = 0; at < count; at += 1) {
			const step = source.draw(bitsStepGen(state))
			steps.push(step)
			state = stepped(state, step)
		}
		return { installed, steps }
	}

/** The handles one byte of a set's bit string holds: a growth of an installation of so many passes the byte. */
const byteHandles = setWidth(1)

/** A history whose every state keeps a live handle: one to a byte's handles installed, then one or two migrations. */
const bitsHistoryGen: Gen<BitsHistory> = (source) =>
	source.draw(bitsHistoryFrom(installedOf(source.draw(int(1, byteHandles))), [], int(1, 2)))

/** A history that grows past a byte: a byte's handles installed, a growth, then at most one more migration. */
const pastDigitHistoryGen: Gen<BitsHistory> = bitsHistoryFrom(
	installedOf(byteHandles),
	[{ kind: "grow" }],
	int(0, 1)
)

export type BitsFeature =
	| "a growth past a byte"
	| "a growth within a byte"
	| "a removal refused until the data step"
	| "two migrations"

/**
 * A history as the generator draws it: while a growth past a byte is pending (gen.ts steered), one that grows past it,
 * and otherwise a drawn one; a rotating case is drawn unaimed.
 */
export const bitsHistories = steered<BitsHistory, BitsFeature>((steering) =>
	Option.exists(steering, (pending) => pending.has("a growth past a byte"))
		? pastDigitHistoryGen
		: bitsHistoryGen
)

/** Each hole pattern's history: its installation, every code live, and the state its migration leaves. */
const histories = Arr.map(patterns, patternHistory)

/** Each pattern's installation, every one of its codes live. */
const installedStates = nonEmpty(
	Arr.map(histories, (h) => h.installed),
	"the installed patterns"
)

/** The probes of every pattern's installation under the declared name `name`. */
export const installedProbes = (name: string): Probes => probesOf(name, installedStates)

/** The probes of every pattern after its holes' handles are removed, under the declared name `name`. */
export const migratedProbes = (name: string): Probes =>
	probesOf(
		name,
		Arr.map(histories, (h) => h.state)
	)

/** The migration that removes every pattern's holes' handles, drafted after the installation (draftNext). */
export const nextOf = (m: Installed) =>
	draftNext(m, m.snapshot, migratedProbes(m.declared).version, 2, holeDrops(patterns))

/**
 * Every pattern installed with each of its codes live, once per member through its first migration (installed.ts
 * migratedOnceTemplate), where each search installed it before its cases.
 */
export const codesInstalledTemplate = migratedOnceTemplate({
	declaredIn: import.meta,
	name: "closed codes installed",
	options: {
		label: "closed_codes",
		first: (name) => installedProbes(name).version,
		later: [],
		apply: { kind: "noPlaceholders" },
		declared: () => noDeclarations
	}
})

/**
 * Every pattern installed and then migrated to its holes, its holes' handles removed, once per member (installed.ts
 * migratedOnceTemplate), where each search installed and migrated it before its cases: a seat's reset empties every
 * probe table after a case.
 */
export const codesMigratedTemplate = migratedOnceTemplate({
	declaredIn: import.meta,
	name: "closed codes migrated",
	options: {
		label: "closed_codes",
		first: (name) => installedProbes(name).version,
		later: [(name) => migratedProbes(name).version],
		apply: { kind: "values", value: () => "'0'" },
		declared: (i) => (i === 0 ? noDeclarations : holeDrops(patterns))
	}
})

/** Every hole pattern of a 5-code roster. */
export const patternCases: Gen<RosterState> = (source) => source.draw(element(patterns))

/** Every roster of every pattern's installation, with each role that uses its codes. */
export const grantCases: Gen<{ readonly state: RosterState; readonly grantee: Grantee }> = (
	source
) => ({
	state: source.draw(element(installedStates)),
	grantee: source.draw(element(grantees))
})

/** What a grantee does with a roster's codes: the writer stores one, the reader decodes the stored ones. */
export const useCodes = (m: Installed, grantee: Grantee, state: RosterState, s: RawSession) =>
	grantee === "writer"
		? Effect.andThen(inTransaction(s, s.query(insertCode(m, state), [1, 0])), s.rollback)
		: Effect.asVoid(
				s.values(
					`SELECT v.${decodedColumn} FROM ${roleNamesOf(m, installedProbes(m.declared).reader).view(probeOf(state))} AS v`,
					[]
				)
			)

/** The role of the installation's probes a grantee is. */
export const granteeRole = (m: Installed, grantee: Grantee): AnyRole => {
	const probes = installedProbes(m.declared)
	return grantee === "writer" ? probes.writer : probes.reader
}

/** A raw session of the migration identity, which owns the installation's schema, for SQL a case runs as the owner. */
export const ownerSessionOf = Effect.flatMap(Substrate, (substrate) =>
	substrate.session({ ...ownerSession(), label: "closed codes owner" })
)
