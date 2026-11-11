import { layer } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { scalarReader } from "#compiler/codec/read.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { Declarations, Named } from "#compiler/deploy/diff/plan.ts"
import { codebookOf, rosterFates } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { type Codebook, codecOf, draftCodebook, noRenames } from "#compiler/ir/codes.ts"
import { Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { login } from "#compiler/program/workload/login.ts"
import { bits, closedId, pg } from "#compiler/public/fields.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type AnyRole,
	closed,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { role } from "#compiler/schema/world.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { apply, kept, noFurther, openMigrator, reviewedSource } from "#test/pg/migrate/support.ts"
import { assert, defined, nonEmpty, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { hexOfText, setText, wholeDigits } from "#test/support/closed/bit-text.ts"
import {
	ALIAS_CODE,
	codeAt,
	everyCode,
	holeFeature,
	holesOf,
	literalFeature,
	liveOf,
	type ModelSlot,
	patternHistory,
	type RosterFeature,
	type RosterState,
	sizeOf
} from "#test/support/closed/generate.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { migrated, noObservation, type Version, workloadOf } from "#test/support/installed.ts"
import { namesOf, parsedName, parsedSchemaName, roleNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { draftedAt, fromSnapshot, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import { planRealInstall, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { expectConstraint, expectSqlstate, inTransaction } from "#test/support/substrate/expect.ts"
import { clearRows, installationGroup } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { outputText, paramText } from "#test/support/wire.ts"

/**
 * Closed ids as codes on PostgreSQL 19rc1: a roster's smallint domain, its names constant, the decoded column of a role
 * view, and a set's bit string, each judged against A8's model of the roster's history (test/support/closed/generate.ts),
 * a list of code slots replayed command by command that shares no code with the engine's codebook.
 *
 * The rosters are every hole pattern of a 5-code roster: 31 rosters, mask m live exactly at the codes whose bit m sets,
 * each reached as a deployment reaches it, by installing every code and then migrating with the holes' handles removed
 * (patternHistory). Each pattern's codes hold plain names in an order its mask rotates, so no name says its code and
 * no two rosters agree on which name a code holds.
 *
 * Properties, and the oracle each is checked against:
 *
 * 1. The view's decoded column `<f>_name`, PostgreSQL's decode of a stored code through the names constant, equals the
 *    host's decode of the same code (the column's codec), for every row: two implementations of one decode, and both the
 *    model's handle.
 * 2. A direct writer's code is accepted exactly when the model says it is live; every other code of −1 … size, and
 *    400, is refused with 23514 on the roster domain's CHECK, the domain its data type. PostgreSQL is the judge. Bound:
 *    every code from −1 to size, then 400, for every hole pattern of a 5-code roster, exhausted (248 cases).
 * 3. A migration that removes a handle a row still holds fails at the domain's VALIDATE with 23514, naming the table and
 *    the column; once a data step removes those rows it applies. Every table holding a removed code is named once, and no
 *    other: set equality against the model.
 * 4. A migration that dropped a roster's names constant before re-pointing its domain fails with 2BP01, PostgreSQL
 *    naming the domain's CHECK as the dependent: DROP FUNCTION … RESTRICT on the installed constant.
 * 5. A backend that cached a domain's CHECK before a migration swapped it judges the next write by the new one: the
 *    same session, open across the migration, answers (2) exactly as a fresh one.
 * 6. A role without EXECUTE on the names constant is refused with 42501, a writer at the domain's CHECK and a reader at
 *    its view's decoded column; with the installed grants both pass, and every role that writes or decodes a roster's
 *    codes holds EXECUTE on its constant.
 * 7. A set round-trips through its bit(n) column, n its codes rounded up to whole hex digits: the text the writer
 *    sends is X then the hex digits of the model's positional text (setText), PostgreSQL stores the positional text,
 *    and the host decodes it to the set sent. After the roster grows, the column is a domain over bit(n′), every stored
 *    set padded with 0s to it, and decodes unchanged; after a removal, VALIDATE names the column of every set that still
 *    holds the removed handle, the data step clears its bit, and the domain then refuses a set holding it.
 * 8. The names constant is the model's names in code order, a hole the empty name: an IMMUTABLE function of no
 *    argument and no SET clause, returning a 1-based name[] of `size` elements, the one function its domain's CHECK
 *    depends on.
 *
 * The bar's mixed-radix alias: a column typed bare smallint, with the roster domain left off (the mutant that drops the
 * domain from a column), accepts 400, which (2) refuses, so (2) kills it.
 */

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
const patterns: NonEmptyReadonlyArray<RosterState> = nonEmpty(
	Arr.map(
		upTo(2 ** patternSize - 1, (i) => i + 1),
		patternOf
	),
	"the patterns"
)

/** The drops of the handles each pattern's history removes, as `--drop Roster#handle` declares them. */
const holeDrops = (states: ReadonlyArray<RosterState>): Declarations => ({
	renames: [],
	drops: Arr.flatMap(states, (state) =>
		Arr.flatMap(state.slots, (slot): ReadonlyArray<Named> =>
			slot.kind === "hole" ? [{ kind: "handle", roster: state.closed, handle: slot.was }] : []
		)
	)
})

/** The relation that stores a pattern's codes. */
const probeOf = (state: RosterState): string => `${state.closed}Probe`

/** The model's name of each code in code order, a hole the empty name: what the names constant must hold. */
const modelNames = (state: RosterState): ReadonlyArray<string> =>
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
const probesOf = (name: string, states: ReadonlyArray<RosterState>): Probes => {
	const declared: Record<string, AnyRelation | AnyClosed> = {}
	const probes: Record<string, AnyRelation> = {}
	for (const state of states) {
		const roster = closed(state.closed, liveOf(state))
		const probe = relation(probeOf(state), { id: pg.integer, code: closedId(roster) }, ["id"])
		declared[state.closed] = roster
		declared[probeOf(state)] = probe
		probes[probeOf(state)] = probe
	}
	const base = schema(name, declared, [])
	const writer = role(base, "writer", probes, { write: Rec.keys(probes), refresh: [] })
	const reader = role(base, "reader", probes, { write: [], refresh: [] })
	return {
		version: { schema: base, logins: [login(base, "desk", [writer, reader])] },
		writer,
		reader
	}
}

/** The domain a roster's codes are typed by, as the installation names it. */
const domainOf = (m: Installed, state: RosterState) => m.names.rosterDomain(state.closed)

/** The roster domain's one CHECK, as the naming door names it. */
const checkOf = (state: RosterState): ConstraintName =>
	identifierOf(identity.domainCheck(identity.rosterDomain(state.closed)))

/** A role view's decoded column of the field `code`, quoted. */
const decodedColumn = quoteIdent(identifierOf(identity.decodedColumn(parsedName("code"))))

/** A pattern's probe table and its columns, quoted for SQL text. */
const probeTable = (m: Installed, state: RosterState) => ({
	table: printObjectName(m.names.relation(probeOf(state))),
	id: quoteIdent(m.names.column(probeOf(state), "id")),
	code: quoteIdent(m.names.column(probeOf(state), "code"))
})

/** A direct writer's INSERT of one probe row, its id and its code bound as text. */
const insertCode = (m: Installed, state: RosterState): string => {
	const p = probeTable(m, state)
	return `INSERT INTO ${p.table} (${p.id}, ${p.code}) VALUES ($1::integer, $2::smallint)`
}

/** A closed id's type over the roster's live handles: the column's codec's type. */
const codeType = (state: RosterState): ScalarType =>
	scalarOf({ kind: "closedId", roster: state.closed }, { [state.closed]: liveOf(state) })

/**
 * The function a domain's CHECK depends on, by pg_depend: its schema, its name and the facts a names constant must
 * have. A CHECK that depends on other than one function is a failure of (8).
 */
const constantOf = (
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
const namesHeld = (session: RawSession, call: string) =>
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
interface Drafted {
	readonly plan: RealInstallPlan
	readonly snapshot: DeploySnapshot
	readonly folder: FolderSource
	readonly codes: Codebook
}

/**
 * The next migration of `m`, from the snapshot `previous` to `version`, as the `ordinal`-th draft, declaring
 * `declared`: its codes drafted from the previous snapshot's for the version's rosters, its installation planned under
 * `m`'s schema with them, and the draft reviewed with every candidate kept.
 */
const draftNext = (
	m: Installed,
	previous: DeploySnapshot,
	version: Version,
	ordinal: number,
	declared: Declarations
) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const owned = succeeded(own(defined(schemaDescOf(version.schema), "a version's schema value")))
		const rosters = rostersOf(owned)
		const codes = succeeded(
			draftCodebook(
				rosterFates(
					previous,
					declared,
					Arr.map(rosters, (r) => r.closed)
				),
				noRenames,
				rosters
			),
			"a version keeps every roster's codes in order"
		)
		const workload = workloadOf(version)
		const plan = succeeded(
			planRealInstall(version.schema, {
				installation: identity.schema(parsedSchemaName(m.declared)),
				owner: substrate.owner.role,
				logins: version.logins,
				extensions: workload.extensions,
				codes,
				compile: compileInstallation
			}),
			"the installation of the next version"
		)
		const g = succeeded(
			generate({
				previous: fromSnapshot(previous),
				installation: plan.installation,
				name: `step_${ordinal}`,
				timestamp: draftedAt(ordinal),
				workload: workload.draft,
				declared
			}),
			"the next migration"
		)
		const drafted: Drafted = { plan, snapshot: g.snapshot, folder: reviewedSource(g, kept), codes }
		return drafted
	})

/** Applies `m`'s folders and then `next` as `m`'s owner login, the runner's MigrateError its failure. */
const applyNext = (m: Installed, next: ReadonlyArray<Drafted>) =>
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
const installFirst = <B>(
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
const sessionOf = (m: Installed, world: AnyRole, label: string) =>
	Effect.flatMap(Substrate, (substrate) =>
		substrate.session({ ...worldSession(m.world(world)), label })
	)

/** What a direct writer's code is, by the model: a live handle's, or the named cause the domain refuses it for. */
type CodeCause = "below" | "past" | "hole" | "alias"

type CodeFeature = RosterFeature | CodeCause

const causeOf = (state: RosterState, code: number): CodeCause =>
	code < 0 ? "below" : code === ALIAS_CODE ? "alias" : code >= sizeOf(state) ? "past" : "hole"

/** The roles that use a roster's codes: one stores them, one decodes them. */
const grantees = ["writer", "reader"] as const

type Grantee = (typeof grantees)[number]

/** Notes a feature the case reached, or both of a pair and the pair. */
const noteReached = (
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
const codeCaseGen: Gen<CodeCase> = (source) => {
	const state = source.draw(element(patterns))
	const entry = source.draw(element(nonEmpty(everyCode(state), "every roster has a code below 0")))
	return { state, code: entry.code, live: entry.live }
}

/**
 * The verdict on `c` in `session`, inside a transaction rolled back after it, so a case leaves no row and replays the
 * same: a live code is stored; any other is refused with 23514 on the roster domain's CHECK, the domain its data type.
 */
const judgeCode = (m: Installed, session: RawSession, c: CodeCase) =>
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
const serverOf = (e: MigrateError) => {
	const server = e.server
	if (server.by !== "server") {
		return assert.fail(`the server reports the failure: ${e.message}`)
	}
	return server.error
}

/** A bits relation's version: roster G of `handles`, Sets of an id and a set over G, written by `writer`. */
const setsOf = (name: string, state: RosterState) => {
	const roster = closed(state.closed, liveOf(state))
	const Sets = relation("Sets", { id: pg.integer, members: bits(roster) }, ["id"])
	const declared: Record<string, AnyRelation | AnyClosed> = { [state.closed]: roster, Sets }
	const base = schema(name, declared, [])
	const writer = role(base, "writer", { Sets }, { write: ["Sets"], refresh: [] })
	const reader = role(base, "reader", { Sets }, { write: [], refresh: [] })
	const version: Version = { schema: base, logins: [login(base, "desk", [writer, reader])] }
	return { version, writer, reader }
}

/** A set's type over the roster's live handles: the column's codec's type. */
const setType = (state: RosterState): ScalarType =>
	scalarOf({ kind: "bits", roster: state.closed }, { [state.closed]: liveOf(state) })

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

/** Every subset of the roster's live handles, in code order: every set a bits value can be. */
const subsetsOf = (state: RosterState): ReadonlyArray<ReadonlyArray<string>> => {
	const none: ReadonlyArray<ReadonlyArray<string>> = [[]]
	return Arr.reduce(liveOf(state), none, (sets, handle) => [
		...sets,
		...Arr.map(sets, (s) => [...s, handle])
	])
}

/** The model's text of a set: position c is 1 exactly when the set holds code c's handle, every padding bit 0. */
const modelText = (state: RosterState, members: ReadonlyArray<string>): string =>
	setText(
		sizeOf(state),
		Arr.map(members, (h) => defined(codeAt(state, h), `${h} is live`))
	)

/** The model's wire text of a set: X, then the hex digits of its positional text. */
const wireText = (state: RosterState, members: ReadonlyArray<string>): ParamText =>
	paramText(`X${hexOfText(modelText(state, members))}`)

/** The type of a column as the catalog holds it: its own type's kind, and its base type formatted with its typmod. */
const columnTypeOf = (session: RawSession, table: string, column: string) =>
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
const domainCheckOf = (
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

const validateCaseGen: Gen<ValidateCase> = (source) => ({
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

type ValidateFeature =
	| "a table holding a removed code named"
	| "a table of holes holding only live codes"
	| "two tables named in turn"

const validateFeatures = (c: ValidateCase, named: number): ReadonlyArray<ValidateFeature> => [
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
const stepped = (state: RosterState, step: BitsStep): RosterState => {
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

/** The handles one hex digit of a set's bit string holds: a growth of an installation of so many passes the digit. */
const digitHandles = wholeDigits(1)

/** A history whose every state keeps a live handle: one to a digit's handles installed, then one or two migrations. */
const bitsHistoryGen: Gen<BitsHistory> = (source) =>
	source.draw(bitsHistoryFrom(installedOf(source.draw(int(1, digitHandles))), [], int(1, 2)))

/** A history that grows past a hex digit: a digit's handles installed, a growth, then at most one more migration. */
const pastDigitHistoryGen: Gen<BitsHistory> = bitsHistoryFrom(
	installedOf(digitHandles),
	[{ kind: "grow" }],
	int(0, 1)
)

type BitsFeature =
	| "a growth past a hex digit"
	| "a growth within a hex digit"
	| "a removal refused until the data step"
	| "two migrations"

/** The history a witness runs: its drawn one, or, while a growth past a hex digit is pending, one that grows past it. */
const aimedHistory = (drawnHistory: BitsHistory, k: Case<BitsFeature>): BitsHistory =>
	Option.getOrUndefined(k.steering)?.has("a growth past a hex digit") === true
		? k.draw(pastDigitHistoryGen)
		: drawnHistory

layer(Substrate.layer)("closed ids as codes on PostgreSQL 19rc1", (it) => {
	it.effect(
		"a roster's domain admits exactly its live codes, in a fresh backend and in one that cached the CHECK a migration swapped",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const histories = Arr.map(patterns, patternHistory)
						const { m, first } = yield* installFirst("closed_codes_domain", (name) =>
							probesOf(
								name,
								Arr.map(histories, (h) => h.installed)
							)
						)
						const stale = yield* sessionOf(m, first.writer, "cached writer")
						for (const h of histories) {
							for (const code of upTo(sizeOf(h.installed), (c) => c)) {
								yield* judgeCode(m, stale, {
									state: h.installed,
									code,
									live: Arr.getUnsafe(liveOf(h.installed), code)
								})
							}
						}
						const next = yield* draftNext(
							m,
							m.snapshot,
							probesOf(
								m.declared,
								Arr.map(histories, (h) => h.state)
							).version,
							2,
							holeDrops(patterns)
						)
						yield* applyNext(m, [next])
						assert.deepEqual(
							Arr.map(patterns, (s) => codecOf(next.codes, new Roster(s.closed, liveOf(s))).names),
							Arr.map(patterns, modelNames),
							"the drafted codebook holds the model's codes"
						)
						const fresh = yield* sessionOf(m, first.writer, "fresh writer")
						return yield* exhaust(
							{
								suite: "pg/closed/codes/domain",
								generator: codeCaseGen,
								literal: Formatter.format,
								limit: patterns.length * (patternSize + 3),
								coverage: requiredInSpace<CodeFeature>([
									"below",
									"past",
									"hole",
									"alias",
									"literal aligned",
									"literal shifted",
									"holes 0",
									"holes 1",
									"holes 2+"
								]),
								caseHang,
								box: "every code from −1 to size, then 400, of every hole pattern of a 5-code roster",
								oracle: {
									kind: "postgresql",
									name: "the domain accepts exactly the codes the history model holds live"
								}
							},
							(c, kase) =>
								Effect.gen(function* () {
									noteReached(
										kase,
										c.live === undefined
											? [holeFeature(c.state), causeOf(c.state, c.code)]
											: literalFeature(c.state, c.live)
									)
									yield* judgeCode(m, fresh, c)
									yield* judgeCode(m, stale, c)
								})
						)
					})
				)
			)
	)

	it.effect(
		"the view decodes every stored code as the host does, and the names constant names each code, a hole the empty name, the one function its domain reads, which RESTRICT keeps",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const histories = Arr.map(patterns, patternHistory)
						const { m } = yield* installFirst("closed_codes_decode", (name) =>
							probesOf(
								name,
								Arr.map(histories, (h) => h.installed)
							)
						)
						const last = probesOf(
							m.declared,
							Arr.map(histories, (h) => h.state)
						)
						const next = yield* draftNext(m, m.snapshot, last.version, 2, holeDrops(patterns))
						yield* applyNext(m, [next])
						const codes = next.codes
						const constants = yield* m.owner.values(
							`SELECT count(*)::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1::text AND p.prorettype = 'pg_catalog.name[]'::regtype`,
							[m.schema]
						)
						assert.equal(
							Number(defined(constants[0])[0]),
							patterns.length,
							"the schema holds one names constant per roster, the migration having dropped every replaced one"
						)
						const writer = yield* sessionOf(m, last.writer, "writer")
						const reader = yield* sessionOf(m, last.reader, "reader")
						const view = roleNamesOf(m, last.reader)
						return yield* exhaust(
							{
								suite: "pg/closed/codes/decode",
								generator: element(patterns),
								literal: (state: RosterState) => state.closed,
								limit: patterns.length,
								box: "every hole pattern of a 5-code roster",
								oracle: {
									kind: "second-implementation",
									name: "the host's decode of each stored code, and the history model's names in code order"
								},
								coverage: requiredInSpace<RosterFeature>(["holes 0", "holes 1", "holes 2+"]),
								caseHang
							},
							(state, c) =>
								Effect.gen(function* () {
									c.note(holeFeature(state))
									const live = liveOf(state)
									yield* clearRows(m.owner, installationGroup(namesOf(m)))
									yield* writer.begin
									for (const [i, handle] of live.entries()) {
										yield* writer.query(insertCode(m, state), [i, defined(codeAt(state, handle))])
									}
									yield* writer.commit
									const codec = scalarReader(codeType(state), codes)
									const rows = yield* reader.values(
										`SELECT v.${view.column(probeOf(state), "code")}::text, v.${decodedColumn} FROM ${view.view(probeOf(state))} AS v ORDER BY v.${view.column(probeOf(state), "id")}`,
										[]
									)
									assert.deepEqual(
										Arr.map(rows, ([code, decoded]) => ({
											host: codec.convert(outputText(String(code))),
											postgres: String(decoded)
										})),
										Arr.map(live, (handle) => ({ host: handle, postgres: handle })),
										`every stored code of ${state.closed} decodes to its handle, on the host and in the view`
									)
									const columns = yield* m.owner.values(
										`SELECT a.attname::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = $1::text::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
										[view.view(probeOf(state))]
									)
									assert.deepEqual(
										Arr.map(columns, (r) => String(r[0])),
										[
											m.names.column(probeOf(state), "id"),
											m.names.column(probeOf(state), "code"),
											identifierOf(identity.decodedColumn(parsedName("code")))
										],
										`the view of ${state.closed} decodes its code in the column after it`
									)
									const constant = yield* constantOf(m.owner, domainOf(m, state))
									const held = yield* namesHeld(reader, constant.call)
									assert.deepEqual(
										held,
										{ lower: "1", cardinality: sizeOf(state), names: [...modelNames(state)] },
										`the names constant of ${state.closed}`
									)
									const refused = yield* expectSqlstate(
										m.owner.query(`DROP FUNCTION ${constant.call} RESTRICT`, []),
										"2BP01"
									)
									const detail = Option.getOrElse(refused.detail, () => "")
									assert.ok(
										Str.includes(checkOf(state))(detail) &&
											Str.includes(domainOf(m, state).name)(detail),
										`dropping the constant of ${state.closed} names its domain's CHECK: ${detail}`
									)
									const after = yield* namesHeld(reader, constant.call)
									assert.deepEqual(after, held, `RESTRICT keeps the constant of ${state.closed}`)
								})
						)
					})
				)
			)
	)

	it.effect(
		"VALIDATE refuses a removed code a row still holds, naming its table and column, and the migration applies after the data step",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/closed/codes/validate",
						draw: drawn(validateCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the tables whose rows hold a code the history model removes"
						},
						coverage: required<ValidateFeature>(
							[
								"a table holding a removed code named",
								"a table of holes holding only live codes",
								"two tables named in turn"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 4,
						shrink: { kind: "bounded", candidates: 8 },
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(c, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								const states = nonEmpty(
									Arr.map(c.rosters, (r) => r.state),
									"a case's rosters"
								)
								const histories = Arr.map(states, patternHistory)
								const { m, first } = yield* installFirst("closed_codes_validate", (name) =>
									probesOf(
										name,
										Arr.map(histories, (h) => h.installed)
									)
								)
								const writer = yield* sessionOf(m, first.writer, "writer")
								yield* writer.begin
								for (const [r, h] of Arr.zip(c.rosters, histories)) {
									for (const code of r.held) {
										yield* writer.query(insertCode(m, h.installed), [code, code])
									}
								}
								yield* writer.commit
								const next = yield* draftNext(
									m,
									m.snapshot,
									probesOf(
										m.declared,
										Arr.map(histories, (h) => h.state)
									).version,
									2,
									holeDrops(states)
								)
								const holding = Arr.filter(c.rosters, (r) =>
									Arr.some(r.held, (code) => holesOf(r.state).includes(code))
								)
								const expected = Arr.map(holding, (r) => ({
									table: m.names.relation(probeOf(r.state)).name,
									column: m.names.column(probeOf(r.state), "code")
								}))
								const named: Array<{ readonly table: string; readonly column: string }> = []
								let applied = false
								for (let attempt = 0; !applied && attempt <= expected.length; attempt += 1) {
									const failure = yield* Effect.match(applyNext(m, [next]), {
										onSuccess: () => undefined,
										onFailure: (e) => e
									})
									if (failure === undefined) {
										applied = true
										continue
									}
									assert.equal(failure.stage, "statement", failure.message)
									const server = serverOf(failure)
									assert.equal(server.sqlstate, sqlstates.checkViolation, failure.message)
									const at = {
										table: defined(server.table, "VALIDATE names the table"),
										column: defined(server.column, "VALIDATE names the column")
									}
									named.push(at)
									const state = defined(
										Arr.findFirst(
											holding,
											(r) => m.names.relation(probeOf(r.state)).name === at.table
										).pipe(
											Option.map((r) => r.state),
											Option.getOrUndefined
										),
										`VALIDATE names a table holding a removed code: ${at.table}`
									)
									const p = probeTable(m, state)
									yield* m.owner.query(
										`DELETE FROM ${p.table} WHERE ${p.code} = ANY ($1::text::smallint[])`,
										[`{${Arr.join(Arr.map(holesOf(state), String), ",")}}`]
									)
								}
								assert.ok(applied, "the migration applies once no row holds a removed code")
								unorderedEqual(
									named,
									expected,
									"VALIDATE names every table holding a removed code, once each"
								)
								for (const r of c.rosters) {
									const p = probeTable(m, r.state)
									const stored = yield* m.owner.values(
										`SELECT ${p.code}::text FROM ${p.table} ORDER BY ${p.code}`,
										[]
									)
									assert.deepEqual(
										Arr.map(stored, (row) => Number(row[0])),
										Arr.filter(r.held, (code) => !holesOf(r.state).includes(code)),
										`${r.state.closed} keeps exactly its live codes' rows`
									)
								}
								k.noteAll(validateFeatures(c, named.length))
							})
						)
				)
			)
	)

	it.effect(
		"a role without EXECUTE on the names constant is refused, a writer at the domain and a reader at the view, and the installed grants give it to both",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const histories = Arr.map(patterns, patternHistory)
						const { m, first } = yield* installFirst("closed_codes_execute", (name) =>
							probesOf(
								name,
								Arr.map(histories, (h) => h.installed)
							)
						)
						const states = nonEmpty(
							Arr.map(histories, (h) => h.installed),
							"the installed patterns"
						)
						const view = roleNamesOf(m, first.reader)
						/** What a grantee does with a roster's codes: the writer stores one, the reader decodes the stored ones. */
						const use = (grantee: Grantee, state: RosterState, s: RawSession) =>
							grantee === "writer"
								? Effect.andThen(
										inTransaction(s, s.query(insertCode(m, state), [1, 0])),
										s.rollback
									)
								: Effect.asVoid(
										s.values(`SELECT v.${decodedColumn} FROM ${view.view(probeOf(state))} AS v`, [])
									)
						const worldOf = (grantee: Grantee): AnyRole =>
							grantee === "writer" ? first.writer : first.reader
						return yield* exhaust(
							{
								suite: "pg/closed/codes/execute",
								generator: (source) => ({
									state: source.draw(element(states)),
									grantee: source.draw(element(grantees))
								}),
								literal: Formatter.format,
								limit: states.length * grantees.length,
								coverage: requiredInSpace<Grantee>(["writer", "reader"]),
								caseHang,
								box: "every roster of every hole pattern's installation, and both roles that use its codes",
								oracle: {
									kind: "postgresql",
									name: "PostgreSQL's EXECUTE check of the function a domain's CHECK and a view call"
								}
							},
							(c, kase) =>
								Effect.gen(function* () {
									kase.note(c.grantee)
									const constant = yield* constantOf(m.owner, domainOf(m, c.state))
									const role = m.role(worldOf(c.grantee))
									const held = yield* m.owner.values(
										`SELECT pg_catalog.has_function_privilege($1::text, $2::text::regprocedure, 'EXECUTE'), (SELECT count(*) FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a WHERE a.grantee = 0) = 0 FROM pg_catalog.pg_proc AS p WHERE p.oid = $2::text::regprocedure`,
										[role, constant.call]
									)
									assert.deepEqual(
										defined(held[0], "the constant's grants"),
										[true, true],
										`the ${c.grantee} holds EXECUTE on the names constant of ${c.state.closed}, and PUBLIC nothing`
									)
									yield* m.owner.query(
										`REVOKE EXECUTE ON FUNCTION ${constant.call} FROM ${quoteIdent(role)}`,
										[]
									)
									const without = yield* sessionOf(
										m,
										worldOf(c.grantee),
										`${c.grantee} without EXECUTE`
									)
									yield* expectSqlstate(use(c.grantee, c.state, without), "42501")
									yield* without.rollback
									yield* m.owner.query(
										`GRANT EXECUTE ON FUNCTION ${constant.call} TO ${quoteIdent(role)}`,
										[]
									)
									const granted = yield* sessionOf(
										m,
										worldOf(c.grantee),
										`${c.grantee} with EXECUTE`
									)
									yield* use(c.grantee, c.state, granted)
								})
						)
					})
				)
			)
	)

	it.effect(
		"a set round-trips through its bit(n) column, decodes unchanged after its roster grows, and a removed handle's bit fails VALIDATE until the data step clears it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/closed/codes/bits",
						draw: drawn(bitsHistoryGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the history model's positional text of each set, and its live handles after each step"
						},
						coverage: required<BitsFeature>(
							[
								"a growth past a hex digit",
								"a growth within a hex digit",
								"a removal refused until the data step",
								"two migrations"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 4,
						shrink: { kind: "bounded", candidates: 8 },
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(drawnHistory, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								const history = aimedHistory(drawnHistory, k)
								const { m, first } = yield* installFirst("closed_codes_bits", (name) =>
									setsOf(name, history.installed)
								)
								const writer = yield* sessionOf(m, first.writer, "writer")
								const reader = yield* sessionOf(m, first.reader, "reader")
								const view = roleNamesOf(m, first.reader)
								const table = printObjectName(m.names.relation("Sets"))
								const id = quoteIdent(m.names.column("Sets", "id"))
								const members = quoteIdent(m.names.column("Sets", "members"))
								/** Every stored set, by id, as PostgreSQL's text. */
								const storedTexts = Effect.map(
									m.owner.values(`SELECT ${members}::text FROM ${table} ORDER BY ${id}`, []),
									Arr.map((r) => String(r[0]))
								)
								/** Every set written so far, by id, as the model holds it: its live handles. */
								let stored: ReadonlyArray<ReadonlyArray<string>> = []
								/** Writes every subset of `state`'s live handles after the stored ones, sent as the host encodes them. */
								const writeEvery = (state: RosterState, codes: Codebook) =>
									Effect.gen(function* () {
										const codec = scalarCodec(setType(state), codes)
										const sets = subsetsOf(state)
										yield* writer.begin
										for (const [i, set] of sets.entries()) {
											const text = succeeded(codec.encode(new Set(set)), "a set of live handles")
											assert.equal(
												text,
												wireText(state, set),
												`the wire text of ${Formatter.format(set)}`
											)
											yield* writer.query(
												`INSERT INTO ${table} (${id}, ${members}) VALUES ($1::integer, $2::text::bit(${wholeDigits(sizeOf(state))}))`,
												[stored.length + i, text]
											)
										}
										yield* writer.commit
										stored = [...stored, ...Arr.map(sets, sortedHandles)]
										const texts = yield* storedTexts
										assert.deepEqual(
											Arr.drop(texts, texts.length - sets.length),
											Arr.map(sets, (set) => modelText(state, set)),
											"PostgreSQL stores each set's positional text"
										)
										assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
											decodes(state, codes, texts),
											stored,
											"every stored set decodes to its live handles"
										)
									})
								const decodes = (
									state: RosterState,
									codes: Codebook,
									texts: ReadonlyArray<string>
								) =>
									Arr.map(texts, (t) =>
										membersOf(scalarReader(setType(state), codes).convert(outputText(t)))
									)
								yield* writeEvery(history.installed, codebookOf(m.snapshot))
								const viewed = yield* reader.values(
									`SELECT v.${view.column("Sets", "members")}::text FROM ${view.view("Sets")} AS v ORDER BY v.${view.column("Sets", "id")}`,
									[]
								)
								const installedTexts = yield* storedTexts
								assert.deepEqual(
									Arr.map(viewed, (r) => String(r[0])),
									installedTexts,
									"the view reads the stored sets"
								)
								let before = history.installed
								let snapshot = m.snapshot
								const drafted: Array<Drafted> = []
								for (const [i, step] of history.steps.entries()) {
									const after = stepped(before, step)
									const next = yield* draftNext(
										m,
										snapshot,
										setsOf(m.declared, after).version,
										i + 2,
										step.kind === "remove"
											? {
													renames: [],
													drops: [{ kind: "handle", roster: after.closed, handle: step.handle }]
												}
											: noDeclarations
									)
									drafted.push(next)
									const textsBefore = yield* storedTexts
									if (step.kind === "remove") {
										/** Every subset was written, so a stored set holds the removed handle. */
										const failure = yield* Effect.flip(applyNext(m, drafted))
										const server = serverOf(failure)
										assert.deepEqual(
											{ sqlstate: server.sqlstate, table: server.table, column: server.column },
											{
												sqlstate: sqlstates.checkViolation,
												table: m.names.relation("Sets").name,
												column: m.names.column("Sets", "members")
											},
											"VALIDATE names the column of the sets that still hold the removed handle"
										)
										yield* m.owner.query(
											`UPDATE ${table} SET ${members} = ${members} & $1::text::bit(${wholeDigits(sizeOf(after))})`,
											[
												setText(
													sizeOf(after),
													Arr.flatMap(after.slots, (slot, code) =>
														slot.kind === "live" ? [code] : []
													)
												)
											]
										)
										k.note("a removal refused until the data step")
									}
									yield* applyNext(m, drafted)
									const afterType = yield* columnTypeOf(
										m.owner,
										table,
										m.names.column("Sets", "members")
									)
									assert.deepEqual(
										{ kind: afterType.kind, base: afterType.base },
										{ kind: "d", base: `bit(${wholeDigits(sizeOf(after))})` },
										"the column is a domain over bit(n), n the roster's codes in whole hex digits"
									)
									const textsAfter = yield* storedTexts
									if (step.kind === "grow") {
										assert.deepEqual(
											textsAfter,
											Arr.map(textsBefore, (t) => Str.padEnd(wholeDigits(sizeOf(after)), "0")(t)),
											"the widening pads every stored set with the new code absent"
										)
										k.note(
											wholeDigits(sizeOf(after)) > wholeDigits(sizeOf(before))
												? "a growth past a hex digit"
												: "a growth within a hex digit"
										)
									} else {
										stored = Arr.map(stored, (set) => Arr.filter(set, (h) => h !== step.handle))
										const check = yield* domainCheckOf(m.owner, afterType.domain)
										const fields = yield* expectConstraint(
											inTransaction(
												writer,
												writer.query(
													`INSERT INTO ${table} (${id}, ${members}) VALUES ($1::integer, $2::text::bit(${wholeDigits(sizeOf(after))}))`,
													[-1, setText(sizeOf(after), [defined(codeAt(before, step.handle))])]
												)
											),
											check,
											"23514"
										)
										yield* writer.rollback
										assert.deepEqual(
											fields.dataType,
											Option.some(afterType.domain.name),
											"the bits domain refuses a set holding the removed handle"
										)
									}
									assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
										decodes(after, next.codes, textsAfter),
										stored,
										"every stored set decodes to its live handles under the step's codes"
									)
									yield* writeEvery(after, next.codes)
									before = after
									snapshot = next.snapshot
								}
								if (history.steps.length > 1) {
									k.note("two migrations")
								}
							})
						)
				)
			)
	)
})
