/**
 * The keys of one relation, declared or a reference's, over the same columns in different orders, against PostgreSQL
 * 19's catalog and its foreign keys. A key holds apart rows equal at a set of columns, whatever order it lists them in
 * (ir/law.ts KeyColumnSet), and PostgreSQL matches a foreign key's referenced columns to a unique index in any order
 * (tablecmds.c transformFkeyCheckAttrs), so a relation holds one key per column set: a containment into a superkey of
 * its target's key needs a UNIQUE over the target's columns, and a fixed target, whose selection fixes a field by a
 * literal beyond its terms, one over its terms and then that field, which its sources meet by a constant each, or one
 * over its own columns, each term generated under its selection, whichever adds fewer objects to the whole schema
 * (laws/model/plan.ts; test/unit/laws/model/probed-target.test.ts judges that choice); each over a set a declared key
 * or an earlier plan states is that key, in its order (laws/model/model.ts nativeIdentity); and a declared key over the
 * set of another key of its relation is refused (schema/own.ts distinctKeys).
 *
 * A case draws T, keyed by `k` over `a`, `b` and `c`, up to two declared keys of T over some of its columns in any
 * order, and two to four references into T, each from a source relation of its own: a superkey reference over `k` and
 * some of the other fields, in any order, or a fixed target over the same, one of the other fields fixed by a literal
 * and the rest its terms in any order. Properties, the specification turned into a checker over the installed catalog
 * and PostgreSQL's verdicts:
 *
 * - the schema compiles exactly when no two of T's keys, its primary key and its distinct declared keys, are over one
 *   column set, and is refused MalformedDescription otherwise;
 * - each source holds one foreign key into T, a superkey reference's over its set and a fixed target's over its terms
 *   and its fixed field or over its own columns;
 * - T holds one unique index per column set, its primary key's, each declared key's and each set a reference's foreign
 *   key lands on, and no other;
 * - every foreign key into T lands on exactly one unique index over its referenced columns, as a set;
 * - each reference's foreign key holds: a source row meeting a row of T commits, all at once, and a source row naming a
 *   key T does not hold is refused by that reference's own foreign key (23503).
 *
 * Every install also passes the installed-catalog checker (test/support/catalog/installed.ts indexProblems), which
 * every suite's install runs: no two unique indexes of a table over one method and column set.
 *
 * And a migration that moves a kept foreign key off the UNIQUE it landed on: S1 references T over (k, a, b) throughout,
 * and a reference of S0's over the same columns, a superkey or a fixed target, which the law model reads first, is added
 * and then dropped, so the one UNIQUE over the set takes S0's order and then S1's again. PostgreSQL bound S1's foreign
 * key to the index it found when it was added, and refuses to drop that index under it (2BP01), so each step drops it
 * only after rebinding the foreign key (deploy/diff/diff.ts rebind). The box: S0's reference over (k, a, b) in every
 * order, a superkey or a fixed target fixing a or b, the walk drafted and applied through the real runner with rows in
 * every table, each apply admitted by the drift check and the installed-catalog checker, the migrated catalog equal to a
 * fresh install of each step, and S1's foreign key refusing a row naming no row of T after every step. T's table is
 * read by the name the installation gives it.
 *
 * Features: two references over one set in two orders, a fixed target and a superkey reference over one set,
 * references over two sets, a declared key and a reference over one set, a fixed target referenced at its own columns,
 * a clash refused, a source row committed and one refused by its own foreign key; the walk must move a kept foreign key
 * off the UNIQUE it landed on. Plant:
 * ~/.cache/grizzle-release/BR09/plants/superkey-orders-unique-per-order.patch, a UNIQUE's identity read in its plan's
 * order instead of as its column set, installs two unique indexes over one set.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, shuffled, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { type Catalogued, seatOf } from "#test/pg/fin/installed.ts"
import {
	apply,
	checkedAdmission,
	kept,
	openMigrator,
	reviewedSource,
	sameCatalog
} from "#test/pg/migrate/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { installationSql, testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	contained,
	eq,
	f,
	field as fieldRef,
	key,
	literal,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { atName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	asDrafted,
	compile,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	ownedBy,
	type Previous
} from "#test/support/migrate/kit.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { attempt } from "#test/support/substrate.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** T's fields beyond its key `k`, which a reference's columns draw from. */
const others = ["a", "b", "c"] as const
type Other = (typeof others)[number]
type Column = "k" | Other

/** T's columns in its declared order. */
const columnsInOrder: Arr.NonEmptyReadonlyArray<Column> = ["k", ...others]

/** The value every row of T holds in each field beyond its key, and the literal every fixed target fixes. */
const held = 7

/**
 * A reference into T: a superkey reference, its columns `k` and some of the other fields in `order`; or a fixed target,
 * `fixed` fixed by the literal and `order` its terms, `k` among them.
 */
type Reference =
	| { readonly kind: "superkey"; readonly order: Arr.NonEmptyReadonlyArray<Column> }
	| {
			readonly kind: "fixed"
			readonly order: Arr.NonEmptyReadonlyArray<Column>
			readonly fixed: Other
	  }

/** The columns of T a reference names, in its order: a fixed target's terms, then its fixed field. */
const columnsOf = (r: Reference): Arr.NonEmptyReadonlyArray<Column> =>
	r.kind === "superkey" ? r.order : Arr.append(r.order, r.fixed)

/**
 * The columns of T a fixed target's own UNIQUE holds: each of its terms generated under its selection, as the seat
 * names a column generated from a field (test/pg/fin/installed.ts).
 */
const ownColumnsOf = (r: Extract<Reference, { readonly kind: "fixed" }>): ReadonlyArray<string> =>
	Arr.map(r.order, (c) => `‹gen ${c}›`)

/** A column set as one text, its columns in code-unit order. */
const setText = (columns: ReadonlyArray<string>): string =>
	Arr.join(Arr.sort(columns, Order.String), ",")

/**
 * A reference: its first field beyond the key and the rest of its set in any order, `k` at any place among its columns;
 * a fixed target fixes the first field, its terms the rest and `k`.
 */
const referenceOver =
	(kind: Reference["kind"], set: Arr.NonEmptyReadonlyArray<Other>): Gen<Reference> =>
	(source) => {
		const first = source.draw(element(set))
		const rest = Arr.filter(set, (o) => o !== first)
		const shuffledRest = source.draw(shuffled(rest, { min: rest.length, max: rest.length }))
		const withKey = (columns: ReadonlyArray<Column>): Arr.NonEmptyReadonlyArray<Column> => {
			const at = source.draw(int(0, columns.length))
			return Arr.appendAll(Arr.append(columns.slice(0, at), "k"), columns.slice(at))
		}
		return kind === "fixed"
			? { kind: "fixed", order: withKey(shuffledRest), fixed: first }
			: { kind: "superkey", order: withKey([first, ...shuffledRest]) }
	}

/** A reference of `kind` over `k` and one to all of T's other fields. */
const referenceOf =
	(kind: Reference["kind"]): Gen<Reference> =>
	(source) => {
		const first = source.draw(element(others))
		const more = source.draw(
			subset(
				Arr.filter(others, (o) => o !== first),
				{ min: 0, max: others.length - 1 }
			)
		)
		return source.draw(referenceOver(kind, Arr.prepend(more, first)))
	}

const referenceGen: Gen<Reference> = (source) =>
	source.draw(referenceOf(source.draw(boolean) ? "fixed" : "superkey"))

/** A key a statement declares on T beside its primary key `k`: some of T's columns, in any order. */
type Declared = Arr.NonEmptyReadonlyArray<Column>

const declaredGen: Gen<Declared> = (source) => {
	const first = source.draw(element(columnsInOrder))
	const more = source.draw(
		subset(
			Arr.filter(columnsInOrder, (c) => c !== first),
			{ min: 0, max: columnsInOrder.length - 1 }
		)
	)
	return Arr.prepend(source.draw(shuffled(more, { min: more.length, max: more.length })), first)
}

/** A case's draw: T's declared keys and the references into it. */
interface Drawn {
	readonly keys: ReadonlyArray<Declared>
	readonly refs: ReadonlyArray<Reference>
}

const drawnGen: Gen<Drawn> = (source) => ({
	keys: source.draw(array(declaredGen, { min: 0, max: 2 })),
	refs: source.draw(array(referenceGen, { min: 2, max: 4 }))
})

type Feature =
	| "two references over one set in two orders"
	| "a fixed target and a superkey reference over one set"
	| "references over two sets"
	| "a declared key and a reference over one set"
	| "a fixed target referenced at its own columns"
	| "a declared key over the set of another key of T refused"
	| "a source row meeting T committed"
	| "a source row naming no row of T refused by its own foreign key"

/** T's keys a statement states, its primary key first: the declared keys, each distinct order once, as a schema's
 * statements declared twice identically are one (schema/own.ts). */
const keysOf = (keys: ReadonlyArray<Declared>): ReadonlyArray<ReadonlyArray<Column>> => [
	["k"],
	...Arr.dedupeWith(keys, (x, y) => Arr.join(x, ",") === Arr.join(y, ","))
]

/** Whether two of T's keys are over one column set, which the schema refuses. */
const clashes = (keys: ReadonlyArray<Declared>): boolean => {
	const sets = Arr.map(keysOf(keys), setText)
	return Arr.dedupe(sets).length < sets.length
}

/** What a case's references hold, from the sketch alone. */
const referenceNotes = (refs: ReadonlyArray<Reference>): ReadonlyArray<Feature> => {
	const pairs = Arr.flatMap(refs, (r, i) => Arr.map(refs.slice(i + 1), (s) => [r, s] as const))
	const sameSet = (r: Reference, s: Reference) => setText(columnsOf(r)) === setText(columnsOf(s))
	return [
		...(Arr.some(
			pairs,
			([r, s]) => sameSet(r, s) && Arr.join(columnsOf(r), ",") !== Arr.join(columnsOf(s), ",")
		)
			? ["two references over one set in two orders" as const]
			: []),
		...(Arr.some(pairs, ([r, s]) => sameSet(r, s) && r.kind !== s.kind)
			? ["a fixed target and a superkey reference over one set" as const]
			: []),
		...(Arr.some(pairs, ([r, s]) => !sameSet(r, s)) ? ["references over two sets" as const] : [])
	]
}

/** What a case holds, from the sketch alone. */
const notesOf = (d: Drawn): ReadonlyArray<Feature> =>
	clashes(d.keys)
		? ["a declared key over the set of another key of T refused"]
		: [
				...referenceNotes(d.refs),
				...(Arr.some(d.keys, (k) => Arr.some(d.refs, (r) => setText(k) === setText(columnsOf(r))))
					? ["a declared key and a reference over one set" as const]
					: [])
			]

/** A superkey reference over the columns of `r`, in any order. */
const superkeyOver =
	(r: Reference): Gen<Reference> =>
	(source) => {
		const columns = columnsOf(r)
		const head = source.draw(element(columns))
		const tail = Arr.filter(columns, (c) => c !== head)
		return {
			kind: "superkey",
			order: Arr.prepend(source.draw(shuffled(tail, { min: tail.length, max: tail.length })), head)
		}
	}

/** Two references over one set in two orders, the first one `kind`. */
const sameSetGen =
	(kind: Reference["kind"]): Gen<Drawn> =>
	(source) => {
		const r = source.draw(referenceOf(kind))
		return { keys: [], refs: [r, source.draw(superkeyOver(r))] }
	}

/** A declared key over the columns of a superkey reference, in another order the reference draws. */
const declaredBesideGen: Gen<Drawn> = (source) => {
	const r = source.draw(referenceOf("superkey"))
	return { keys: [columnsOf(r)], refs: [source.draw(superkeyOver(r))] }
}

/**
 * Two fixed targets over T's key alone under one selection, each from its own source: the shared UNIQUE adds its index
 * and a constant on each source, the own one its index and one generated column (laws/model/plan.ts).
 */
const sameTargetGen: Gen<Drawn> = (source) => {
	const r: Reference = { kind: "fixed", order: ["k"], fixed: source.draw(element(others)) }
	return { keys: [], refs: [r, r] }
}

/** A declared key over T's primary key's set, or two declared keys over one set of two columns in both orders. */
const clashGen: Gen<Drawn> = (source) => {
	const first = source.draw(element(others))
	const primary: Column = "k"
	const rest: Arr.NonEmptyReadonlyArray<Column> = Arr.prepend(
		Arr.filter(others, (c) => c !== first),
		primary
	)
	const second = source.draw(element(rest))
	return {
		keys: source.draw(boolean)
			? [["k"]]
			: [
					[first, second],
					[second, first]
				],
		refs: []
	}
}

/** What each required situation is aimed at while it is pending (Case.steering). */
const aims: ReadonlyArray<readonly [Feature, Gen<Drawn>]> = [
	["two references over one set in two orders", sameSetGen("superkey")],
	["a fixed target and a superkey reference over one set", sameSetGen("fixed")],
	[
		"references over two sets",
		() => ({
			keys: [],
			refs: [
				{ kind: "superkey", order: ["k", "a"] },
				{ kind: "superkey", order: ["b", "k"] }
			]
		})
	],
	["a declared key and a reference over one set", declaredBesideGen],
	["a fixed target referenced at its own columns", sameTargetGen],
	["a declared key over the set of another key of T refused", clashGen]
]

/** A case's draw, and, while a situation `aims` reaches is pending, what is aimed at it beside it. */
const aimed = (d: Drawn, c: Case<Feature>): Drawn => {
	const pending = Option.getOrUndefined(c.steering)
	const aim = Arr.findFirst(aims, ([feature]) => pending?.has(feature) === true)
	if (Option.isNone(aim)) {
		return d
	}
	const more = c.draw(aim.value[1])
	return { keys: [...d.keys, ...more.keys], refs: [...d.refs, ...more.refs] }
}

/** The source relation of reference `i`: its key `id`, and a field for each of T's columns. */
const sourceName = (i: number): string => `S${i}`
const sourceField = (c: Column): string => `x${c}`

/** Reference `r`'s containment from source `i`'s fields into T. */
const containmentOf = (r: Reference, i: number) =>
	r.kind === "superkey"
		? contained(on(sourceName(i), Arr.map(r.order, sourceField)), on("T", r.order))
		: contained(
				on(sourceName(i), Arr.map(r.order, sourceField)),
				onWhere("T", r.order, eq(fieldRef(r.fixed), literal(held)))
			)

/** T and `sources` source relations, with `statements`. */
const schemaWith = (sources: number, statements: SchemaDesc["statements"]): SchemaDesc => ({
	name: "SuperkeyOrders",
	relations: [
		relation("T", { k: f.integer, a: f.integer, b: f.integer, c: f.integer }, ["k"]),
		...upTo(sources, (i) =>
			relation(
				sourceName(i),
				{ id: f.integer, xk: f.integer, xa: f.integer, xb: f.integer, xc: f.integer },
				["id"]
			)
		)
	],
	statements,
	extends: undefined
})

/** The schema of a case: T with its declared keys, and each reference's source, with the reference's containment. */
const schemaOf = (d: Drawn): SchemaDesc =>
	schemaWith(d.refs.length, [
		...Arr.map(d.keys, (k) => key(on("T", k))),
		...Arr.map(d.refs, containmentOf)
	])

/** The unique and primary constraints of T, and the foreign keys into it. */
const keysOfT = (constraints: ReadonlyArray<Catalogued>): ReadonlyArray<Catalogued> =>
	Arr.filter(
		constraints,
		(c) => c.relation === "T" && (c.kind === "unique" || c.kind === "primary")
	)

const referencesCase = (d: Drawn, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		for (const feature of notesOf(d)) {
			note(feature)
		}
		const refs = d.refs
		const compiled = testArtifacts(schemaOf(d), testCompile)
		if (clashes(d.keys)) {
			assert.ok(
				!compiled.ok && compiled.error.reason._tag === "MalformedDescription",
				`two keys of T over one column set are refused MalformedDescription, not ${compiled.ok ? "admitted" : compiled.error.message}`
			)
			return
		}
		assert.ok(
			compiled.ok,
			`T's keys over distinct column sets compile, not ${compiled.ok ? "" : compiled.error.message}`
		)
		const relations: Arr.NonEmptyReadonlyArray<string> = [
			"T",
			...Arr.map(refs, (_, i) => sourceName(i))
		]
		const seat = yield* seatOf(schemaOf(d), relations, "superkey orders")
		const keys = keysOfT(seat.constraints)
		const sets = Arr.map(keys, (c) => setText(c.columns))
		const landings = Arr.map(refs, (r, i) => {
			const into = Arr.filter(
				seat.constraints,
				(c) =>
					c.kind === "foreign" &&
					c.relation === sourceName(i) &&
					Option.exists(c.target, (t) => t.relation === "T")
			)
			const [fk, ...more] = into
			if (fk === undefined || more.length > 0) {
				return assert.fail(`${sourceName(i)} holds one foreign key into T, not ${into.length}`)
			}
			const landing = Option.match(fk.target, {
				onNone: () => "",
				onSome: (t) => setText(t.columns)
			})
			const allowed =
				r.kind === "superkey"
					? [setText(columnsOf(r))]
					: [setText(columnsOf(r)), setText(ownColumnsOf(r))]
			assert.ok(
				Arr.contains(allowed, landing),
				`${sourceName(i)}'s foreign key lands on ${Arr.join(allowed, " or ")}, not ${landing}`
			)
			if (r.kind === "fixed" && landing === setText(ownColumnsOf(r))) {
				note("a fixed target referenced at its own columns")
			}
			return landing
		})
		const expected = Arr.dedupe([...Arr.map(keysOf(d.keys), setText), ...landings])
		assert.deepEqual(
			Arr.sort(sets, Order.String),
			Arr.sort(expected, Order.String),
			"T holds one unique index per column set: each declared key's and each a reference's foreign key lands on"
		)
		for (const fk of seat.constraints) {
			if (fk.kind !== "foreign" || Option.isNone(fk.target) || fk.target.value.relation !== "T") {
				continue
			}
			const referenced = setText(fk.target.value.columns)
			assert.equal(
				Arr.filter(sets, (s) => s === referenced).length,
				1,
				`${fk.name} lands on exactly one unique index over ${referenced}`
			)
		}
		const t = seat.table("T")
		const col = (r: string, c: string) => seat.column(r, c)
		const row = (r: string, id: number, key: number) =>
			`INSERT INTO ${seat.table(r)} (${col(r, "id")}, ${Arr.join(
				Arr.map(columnsInOrder, (c) => col(r, sourceField(c))),
				", "
			)}) VALUES (${id}, ${key}, ${held}, ${held}, ${held})`
		const meeting = yield* attempt(seat.session, [
			`INSERT INTO ${t} (${col("T", "k")}, ${col("T", "a")}, ${col("T", "b")}, ${col("T", "c")}) VALUES (1, ${held}, ${held}, ${held})`,
			...Arr.map(refs, (_, i) => row(sourceName(i), 1, 1))
		])
		assert.equal(
			meeting.kind,
			"committed",
			"a source row meeting T's row commits for every reference"
		)
		note("a source row meeting T committed")
		for (const [i] of refs.entries()) {
			const naming = yield* attempt(seat.session, [row(sourceName(i), 2, 2)])
			if (naming.kind !== "refused") {
				return assert.fail(`${sourceName(i)}'s row naming no row of T commits`)
			}
			const by = seat.refusedBy(naming.fields)
			assert.ok(
				naming.fields.code === "23503" &&
					Option.exists(by, (c) => c.kind === "foreign" && c.relation === sourceName(i)),
				`${sourceName(i)}'s row naming no row of T is refused by its own foreign key, not ${naming.fields.code} by ${Option.match(by, { onNone: () => "no constraint", onSome: (c) => c.name })}`
			)
		}
		note("a source row naming no row of T refused by its own foreign key")
	})

/** S1's reference into T, which every step of the walk keeps. */
const kept1: Reference = { kind: "superkey", order: ["k", "a", "b"] }

/** S0's reference over S1's columns, a superkey or a fixed target, in any order (the header). */
const secondGen: Gen<Reference> = (source) =>
	source.draw(referenceOver(source.draw(boolean) ? "fixed" : "superkey", ["a", "b"]))

/**
 * A step of the walk: T, S0 and S1, S1's reference kept, and S0's `second` beside it when it is one. The law model reads
 * a schema's statements in their canonical order (schema/own.ts), S0's before S1's, so the UNIQUE over the set takes
 * S0's order while S0 references T and S1's otherwise.
 */
const stepOf = (second: Reference | undefined): SchemaDesc =>
	schemaWith(
		2,
		second === undefined
			? [containmentOf(kept1, 1)]
			: [containmentOf(second, 0), containmentOf(kept1, 1)]
	)

/** T's unique constraints, by name, as the catalog holds them: the one over S1's columns. */
const uniqueOverSet = (table: { readonly schema: string; readonly name: string }) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(
			"SELECT c.conname::text FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid = c.conrelid " +
				"JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = $1 AND r.relname = $2 AND c.contype = 'u'",
			[table.schema, table.name]
		)
		return Arr.map(rows, (row) => String(row[0]))
	})

const walkCase = (
	second: Reference,
	note: (feature: "a kept foreign key moved off the UNIQUE it landed on") => void
) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const owner = substrate.owner.role
		const name = yield* substrate.schema({ create: false, label: "superkey_moves" })
		const m = yield* openMigrator(substrate, substrate.owner)
		const over = { ...asDrafted, schema: atName(name), owner: ownedBy(owner) }
		const steps = [stepOf(undefined), stepOf(second), stepOf(undefined)] as const
		const folders: Array<FolderSource> = []
		let previous: Previous = fromEmpty
		let landed: ReadonlyArray<string> = []
		for (const [i, step] of steps.entries()) {
			const installation = compile(step, over)
			const g = succeeded(
				generate({
					previous,
					installation,
					name: `step_${i + 1}`,
					timestamp: draftedAt(i + 1),
					workload: noWorkload,
					declared: noDeclarations
				})
			)
			folders.push(reviewedSource(g, kept))
			yield* apply(
				m,
				{ snapshot: g.snapshot, folders: [...folders] },
				checkedAdmission(installation, substrate.admin)
			)
			previous = fromSnapshot(g.snapshot)
			const table = (relation: string) => {
				const q = installation.names.relation(relation)
				return `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
			}
			const column = (relation: string, field: string) =>
				quoteIdent(installation.names.column(relation, field))
			const sourceRow = (relation: string, id: number, key: number) =>
				`INSERT INTO ${table(relation)} (${Arr.join(
					Arr.map(["id", "xk", "xa", "xb", "xc"], (fld) => column(relation, fld)),
					", "
				)}) VALUES (${id}, ${key}, ${held}, ${held}, ${held})`
			if (i === 0) {
				yield* transaction(substrate.admin, [
					`INSERT INTO ${table("T")} (${Arr.join(
						Arr.map(["k", "a", "b", "c"], (fld) => column("T", fld)),
						", "
					)}) VALUES (1, ${held}, ${held}, ${held})`,
					sourceRow(sourceName(0), 1, 1),
					sourceRow(sourceName(1), 1, 1)
				])
			}
			const uniques = yield* uniqueOverSet(installation.names.relation("T"))
			assert.equal(uniques.length, 1, `step ${i + 1}: T holds one UNIQUE over S1's columns`)
			if (i > 0 && Arr.join(uniques, ",") !== Arr.join(landed, ",")) {
				note("a kept foreign key moved off the UNIQUE it landed on")
			}
			landed = uniques
			const refused = yield* Effect.flip(
				transaction(substrate.admin, [sourceRow(sourceName(1), 2, 2)])
			)
			assert.equal(
				pgErrorFields(refused)?.code,
				"23503",
				`step ${i + 1}: S1's foreign key refuses a row naming no row of T`
			)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const schema = yield* substrate.schema({ create: false, label: "superkey_fresh" })
					const fresh = compile(step, { ...over, schema: atName(schema) })
					yield* transaction(substrate.admin, installationSql(fresh, substrate.database))
					yield* sameCatalog(
						installation,
						fresh,
						`step ${i + 1}: the migrated walk against a fresh install`
					)
				})
			)
		}
	})

layer(Substrate.layer)("references into one relation's superkeys in different orders", (it) => {
	it.effect(
		"one unique index per column set, every reference's foreign key landing on it and holding",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the keys T declares and its references' sets, against its installed unique indexes and PostgreSQL's foreign-key verdicts"
						},
						suite: "laws/superkey-orders",
						draw: drawn(drawnGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"two references over one set in two orders",
								"a fixed target and a superkey reference over one set",
								"references over two sets",
								"a declared key and a reference over one set",
								"a fixed target referenced at its own columns",
								"a declared key over the set of another key of T refused",
								"a source row meeting T committed",
								"a source row naming no row of T refused by its own foreign key"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 12,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d, cx) => Effect.scoped(referencesCase(aimed(d, cx), cx.note))
				)
			)
	)
	it.effect(
		"a migration moves a kept foreign key off the UNIQUE it landed on when the set's order changes",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "laws/superkey-moves",
						generator: secondGen,
						literal: Formatter.format,
						box: "S0's reference over S1's columns (k, a, b) in every order, a superkey or a fixed target fixing a or b, added and dropped again",
						oracle: {
							kind: "specification",
							name: "the drift check and catalog checker after every apply, a fresh install's catalog, and S1's foreign key refusing a row naming no row of T"
						},
						coverage: requiredInSpace<"a kept foreign key moved off the UNIQUE it landed on">([
							"a kept foreign key moved off the UNIQUE it landed on"
						]),
						caseHang
					},
					(second, c) => Effect.scoped(walkCase(second, c.note))
				)
			)
	)
})
