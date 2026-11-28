/**
 * The fin suites' seat: a schema of families installed through grizzle's own lowering, its first migration, beside the
 * physical names a direct writer addresses its rows by and its catalog's constraints, each described by the roles of
 * the columns it reads. A suite names what PostgreSQL refused by those roles, never by a name the naming door
 * allocated, so its verdicts read off what grizzle installed and nothing the suite restates.
 *
 * A column's role is its field's name for a field, and for a law column what its native says it holds: `‹s›` (a
 * family member's successor), `‹i›` (a counted family's index), `‹before f.p›` and `‹after f.p›` (fold f's plane p
 * accumulators), and `‹gen x›` for a column generated from field x (a selected group's guarded term, an owner's key
 * where its count is above 0, or a pred of the index or the count). A constraint is described by its kind, its relation and
 * its columns' roles in key order, a foreign key also by its target's, with its deferral and its update action as the
 * catalog states them, and the law the installation's constraint map says it reports.
 */
import { constant, type Gen, type Weight, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, type Scope, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import {
	type Installed,
	installedTemplate,
	installMigrated,
	seededTemplate
} from "#test/support/install-migrate.ts"
import { standUpJudge } from "#test/support/judge.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type Attempted, attempt, attemptChecked, type Checked } from "#test/support/substrate.ts"
import type { PgErrorFields, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { clearRows, tablesGroup } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import {
	ownerSession,
	Substrate,
	type SubstrateCase,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"

/** A constraint's kind as pg_constraint's contype states it, a unique index backing none a `unique`. */
export type ConstraintKind = "primary" | "unique" | "check" | "foreign"

/** One constraint of the installed catalog, described by roles (the header). */
export interface Catalogued {
	readonly name: string
	readonly kind: ConstraintKind
	/** The declared relation it lives on. */
	readonly relation: string
	readonly columns: ReadonlyArray<string>
	/** A foreign key's target relation and columns, in key order. */
	readonly target: Option.Option<{
		readonly relation: string
		readonly columns: ReadonlyArray<string>
	}>
	readonly deferrable: boolean
	/** Whether a foreign key cascades an update of its target's columns into its own. */
	readonly cascades: boolean
	/**
	 * Every law the installation names a violation of it by, each once, in code point order, as its constraint map holds
	 * them (ir/products.ts ConstraintLaws): a family's primary key serves the family's law and the key's, an axis's
	 * foreign key and unique index each law riding it; none where the map holds no such constraint.
	 */
	readonly laws: ReadonlyArray<LawId>
}

/** A schema installed for a fin suite, with the session its transactions run on as the installation's owner. */
export interface Seat {
	readonly label: string
	readonly installed: Installed
	readonly model: LawModel
	readonly session: RawSession
	/** A declared relation's table, schema-qualified and quoted. */
	readonly table: (relation: string) => string
	/** The quoted column of a declared relation that holds a role (a field's name, or a law column's role). */
	readonly column: (relation: string, role: string) => string
	/** The roles of a declared relation's columns, in its table's order. */
	readonly roles: (relation: string) => ReadonlyArray<string>
	readonly constraints: ReadonlyArray<Catalogued>
	/** The installed constraint a refusal names, by its table and constraint name. */
	readonly refusedBy: (fields: PgErrorFields) => Option.Option<Catalogued>
	/** The laws of the theory whose detail is of a kind (family, tree, fold, containment, …), in law order. */
	readonly lawsOf: (kind: string) => ReadonlyArray<LawId>
}

/** The field a law column's values are of, as the law model planned it. */
const heldName = (
	plan: Extract<LawModel["natives"][number], { readonly namespace: "column" }>["plan"]
): string => {
	switch (plan.kind) {
		case "term":
			return plan.term.column.name
		case "constant":
		case "drawn":
		case "indexPred":
			return plan.field.name
	}
}

/** The role a law column holds, from the native that adds it. */
const lawColumnRole = (
	native: Extract<LawModel["natives"][number], { readonly namespace: "column" }>
): string => {
	const value = native.object
	if (value.value.kind !== "drawn") {
		return `‹gen ${heldName(native.plan)}›`
	}
	const d = value.value.draws
	switch (d.kind) {
		case "next":
			return "‹s›"
		case "index":
			return "‹i›"
		case "before":
		case "after":
			return `‹${d.kind} ${d.fold}.${d.plane}›`
	}
}

/**
 * A drawn law column's role qualified by its family, `‹i›` as `‹i@debits›`: what tells apart the columns of a member of
 * several counted families, each family's own by its count. A generated column is told apart by its field already.
 */
const familyRole = (
	role: string,
	value: Extract<LawModel["natives"][number], { readonly namespace: "column" }>["object"]
): string =>
	value.value.kind === "drawn"
		? `${Str.slice(0, -1)(role)}@${value.value.draws.family.count}›`
		: role

/** The unit separator, which no identifier holds, joining a catalog list into one text. */
const SEP = "\u001f"

/** Every constraint and backing-free unique index of the schema, with its relation's and its target's identifiers. */
const catalogSql = `
SELECT c.conname::text, r.relname::text, c.contype::text, c.condeferrable, c.confupdtype::text,
	coalesce((SELECT string_agg(a.attname::text, E'\\x1f' ORDER BY k.o) FROM unnest(c.conkey) WITH ORDINALITY AS k(n, o)
		JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n), ''),
	coalesce(t.relname::text, ''),
	coalesce((SELECT string_agg(a.attname::text, E'\\x1f' ORDER BY k.o) FROM unnest(c.confkey) WITH ORDINALITY AS k(n, o)
		JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n), '')
FROM pg_catalog.pg_constraint c
JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
JOIN pg_catalog.pg_namespace s ON s.oid = r.relnamespace
LEFT JOIN pg_catalog.pg_class t ON t.oid = c.confrelid
WHERE s.nspname = ANY($1::text[]) AND c.contype IN ('p', 'u', 'c', 'f')
UNION ALL
SELECT x.relname::text, r.relname::text, 'u', false, ' ',
	(SELECT string_agg(a.attname::text, E'\\x1f' ORDER BY k.o) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(n, o)
		JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n), '', ''
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
JOIN pg_catalog.pg_class r ON r.oid = i.indrelid
JOIN pg_catalog.pg_namespace s ON s.oid = r.relnamespace
WHERE s.nspname = ANY($1::text[]) AND i.indisunique
	AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = i.indexrelid)`

const kindOf = (contype: string): ConstraintKind => {
	switch (contype) {
		case "p":
			return "primary"
		case "c":
			return "check"
		case "f":
			return "foreign"
		default:
			return "unique"
	}
}

const listOf = (text: unknown): ReadonlyArray<string> =>
	text === "" ? [] : Str.split(String(text), SEP)

/**
 * A seat's label as a schema label, which the substrate takes as a lowercase word of letters joined by underscores
 * (substrate/names.ts): its letters lowered, every other run of characters one underscore, at most 24 characters.
 */
const schemaLabelOf = (label: string): string => {
	const letters = Arr.map(Str.split(Str.toLowerCase(label), ""), (ch) =>
		ch >= "a" && ch <= "z" ? ch : " "
	)
	const words = Arr.filter(Str.split(Arr.join(letters, ""), " "), Str.isNonEmpty)
	const joined = Str.slice(0, 24)(Arr.join(words, "_"))
	const trimmed = Str.endsWith("_")(joined) ? Str.slice(0, -1)(joined) : joined
	return trimmed === "" ? "fin" : trimmed
}

/**
 * Installs `schema` through its first migration (test/support/install-migrate.ts), opens an owner session on it, and
 * reads its catalog. `relations` names every stored relation of the schema a suite writes or reads.
 */
export const seatOf = (
	schema: FixtureSchema,
	relations: Arr.NonEmptyReadonlyArray<string>,
	label: string
): Effect.Effect<Seat, CompileError | SqlError | TransactionRolledBack, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const installed = yield* installMigrated(schema, {
			ambient: ordinarySession,
			extensions: [],
			label: schemaLabelOf(label)
		})
		return yield* seatOfInstalled(installed, relations, label)
	})

/** A fin schema's template (seatTemplate), and a case over a clone of it, whose value is its installation there. */
export type SeatTemplate = SubstrateTemplate<Installed>

export type SeatCase = SubstrateCase<Installed>

/**
 * seatOf's installation as a template (install-migrate.ts installedTemplate): `schema` migrated through its first
 * migration once per member, under `label`, which names the template among its declaring module's. A case takes a
 * clone of its own (Substrate.fresh), dropped after it, and reads its seat there (seatIn).
 */
export const seatTemplate = (
	declaredIn: ImportMeta,
	schema: FixtureSchema,
	label: string
): SeatTemplate =>
	installedTemplate({
		declaredIn,
		name: label,
		schema,
		options: { ambient: ordinarySession, extensions: [], label: schemaLabelOf(label) }
	})

/**
 * seatTemplate's installation with what every case reads written once per member right after the install
 * (install-migrate.ts seededTemplate): `seed` over the build's seat of it (seatOfInstalled), such as a planted load
 * analyzed, where a search wrote it once before its cases. A case reads its seat as seatTemplate's (seatIn).
 */
export const seededSeatTemplate = <E>(
	declaredIn: ImportMeta,
	schema: FixtureSchema,
	relations: Arr.NonEmptyReadonlyArray<string>,
	label: string,
	seed: (seat: Seat) => Effect.Effect<void, E, Substrate | Scope.Scope>
): SeatTemplate =>
	seededTemplate({
		declaredIn,
		name: label,
		schema,
		options: { ambient: ordinarySession, extensions: [], label: schemaLabelOf(label) },
		seed: (installed) => Effect.flatMap(seatOfInstalled(installed, relations, label), seed)
	})

/** The seat of a case over a clone of a fin template (seatTemplate): seatOfInstalled on the case's own substrate. */
export const seatIn = (
	taken: SeatCase,
	relations: Arr.NonEmptyReadonlyArray<string>,
	label: string
): Effect.Effect<Seat, SqlError, Scope.Scope> =>
	Effect.provideService(seatOfInstalled(taken.value, relations, label), Substrate, taken.substrate)

/**
 * The seat of an installation already made: its owner session, and the catalog of every PostgreSQL schema `relations`
 * live in, a level's own beside the root's, read now.
 */
export const seatOfInstalled = (
	installed: Installed,
	relations: Arr.NonEmptyReadonlyArray<string>,
	label: string
): Effect.Effect<Seat, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const model = installed.installation.laws
		const identOf = (relation: string): string => installed.names.relation(relation).name
		const declaredOf = new Map(Arr.map(relations, (r) => [identOf(r), r] as const))
		/** Each relation's column identifiers to roles: its fields by name, its law columns by native. */
		const rolesByColumn = new Map<string, Map<string, string>>()
		for (const relation of relations) {
			const byColumn = new Map<string, string>()
			const info = model.checked.relations.get(relation)
			for (const field of info === undefined ? [] : info.fields) {
				byColumn.set(field.column, field.name)
			}
			const lawColumns = Arr.flatMap(model.natives, (native) =>
				native.namespace === "column" && native.object.relation.name === relation ? [native] : []
			)
			const roles = Arr.map(lawColumns, lawColumnRole)
			for (const [i, { object }] of lawColumns.entries()) {
				const role = Arr.getUnsafe(roles, i)
				const shared = Arr.filter(roles, (r) => r === role).length > 1
				byColumn.set(object.column, shared ? familyRole(role, object) : role)
			}
			rolesByColumn.set(relation, byColumn)
		}
		const roleOf = (relation: string, column: string): string =>
			rolesByColumn.get(relation)?.get(column) ?? `?${column}`
		const rows = yield* substrate.admin.queryValues(catalogSql, [
			Arr.dedupe(Arr.map(relations, (r) => installed.names.relation(r).schema))
		])
		const constraints = Arr.flatMap(rows, (row): ReadonlyArray<Catalogued> => {
			const [name, table, contype, deferrable, updtype, columns, target, targetColumns] = row
			const relation = declaredOf.get(String(table))
			if (relation === undefined) {
				return []
			}
			const targetRelation = declaredOf.get(String(target))
			return [
				{
					name: String(name),
					kind: kindOf(String(contype)),
					relation,
					columns: Arr.map(listOf(columns), (c) => roleOf(relation, c)),
					target:
						targetRelation === undefined
							? Option.none()
							: Option.some({
									relation: targetRelation,
									columns: Arr.map(listOf(targetColumns), (c) => roleOf(targetRelation, c))
								}),
					deferrable: deferrable === true,
					cascades: updtype === "c",
					laws:
						lawsOfConstraint(
							installed.installation.constraintToLaw,
							{ kind: "table", name: installed.names.relation(relation).name },
							String(name)
						) ?? []
				}
			]
		})
		const session = yield* substrate.session({ ...ownerSession(), label })
		yield* standUpJudge(session, installed.installation)
		const columnOf = (relation: string, role: string): string => {
			const byColumn = rolesByColumn.get(relation) ?? new Map<string, string>()
			const found = Arr.findFirst([...byColumn], ([, r]) => r === role)
			if (Option.isNone(found)) {
				throw new Error(
					`the seat ${label} holds no column of role ${role} on ${relation}: its roles are ${Arr.join([...byColumn.values()], ", ")}`
				)
			}
			return quoteIdent(found.value[0])
		}
		return {
			label,
			installed,
			model,
			session,
			table: (relation) => printObjectName(installed.names.relation(relation)),
			column: columnOf,
			roles: (relation) => [...(rolesByColumn.get(relation)?.values() ?? [])],
			constraints,
			refusedBy: (fields) =>
				Arr.findFirst(
					constraints,
					(c) =>
						c.name === fields.constraint &&
						Option.exists(fields.table, (t) => declaredOf.get(t) === c.relation)
				),
			lawsOf: (kind) =>
				Arr.map(
					Arr.filter(model.theory.laws, (l) => l.detail.kind === kind),
					(l) => l.id
				)
		} satisfies Seat
	})

/** Whether a role list holds every role of `wanted`. */
const holdsAll = (columns: ReadonlyArray<string>, wanted: ReadonlyArray<string>): boolean =>
	Arr.every(wanted, (w) => columns.includes(w))

/** Whether two role lists hold the same roles, in any order. */
export const sameRoles = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && holdsAll(a, b)

/** A constraint as a report reads it: its kind, relation, roles and target. */
export const constraintText = (c: Catalogued): string =>
	`${c.kind} ${c.relation}(${Arr.join(c.columns, ", ")})${Option.match(c.target, {
		onNone: () => "",
		onSome: (t) => ` → ${t.relation}(${Arr.join(t.columns, ", ")})`
	})}${c.deferrable ? " deferrable" : ""}${c.cascades ? " on update cascade" : ""}`

/**
 * Removes every row of the relations, so a replacement (replaced) starts empty: the one reset (substrate/replace.ts
 * clearRows), a READ COMMITTED deletion under the replica role, which fires no guard and holds no SIREAD lock.
 */
const cleared = (
	seat: Seat,
	relations: Arr.NonEmptyReadonlyArray<string>
): Effect.Effect<void, SqlError> =>
	clearRows(seat.session, tablesGroup(Arr.map(relations, seat.table), []))

/**
 * Replaces every row of the relations with what `statements` write: the relations emptied (cleared), then one
 * SERIALIZABLE transaction of the statements, which reads no version a serializable transaction wrote (substrate/
 * replace.ts replaceRows), so it is never an SSI pivot and the case it starts meets only its own state and leaves its
 * rows for the next replacement: its verdict, a refusal's moment counted over `statements`.
 */
export const replaced = (
	seat: Seat,
	relations: Arr.NonEmptyReadonlyArray<string>,
	statements: ReadonlyArray<string>
): Effect.Effect<Attempted, SqlError | TransactionRolledBack> =>
	Effect.andThen(cleared(seat, relations), attempt(seat.session, statements))

/**
 * How a case's transaction ends: `checked`, its commit's checks run by SET CONSTRAINTS ALL IMMEDIATE, what it left
 * read, and rolled back (substrate.ts attemptChecked); or `commit`, a real COMMIT, what it committed read. In a session
 * of its own every deferred check fires at SET CONSTRAINTS ALL IMMEDIATE as it would at COMMIT, so the model's verdict
 * is the same for both, and the transactions that end by COMMIT show a real commit never decides otherwise than the
 * checked end.
 */
export type End = "checked" | "commit"

/** What a case's end reached: the end it took, and the end that met a refusal at the commit. */
export type EndFeature =
	| "a case ended by COMMIT"
	| "a case ended by SET CONSTRAINTS and ROLLBACK"
	| "a case refused at a real COMMIT"
	| "a case refused at its checked commit"

/**
 * How often a drawn case ends by each end: a search budget, never a claim. Both ends are a case's to take, so an
 * exhaustion enumerates both for every case of its box, whatever the weights, and a sampled search draws them in this
 * proportion; the checked end is first, so a failing case shrinks toward it.
 */
const endWeights = { checked: 1, commit: 1 } as const satisfies Readonly<Record<End, Weight>>

/**
 * The end of a case's transaction, drawn on its tape (End), so a replay ends it as it ended: each end meets every
 * transaction of a box, its refusals at commit among them, and the transactions that end by COMMIT show a real commit
 * never decides otherwise than the checked end.
 */
export const endGen: Gen<End> = weighted([
	[endWeights.checked, constant("checked")],
	[endWeights.commit, constant("commit")]
])

/** The feature of the end a case took. */
export const endedBy = (end: End): EndFeature =>
	end === "commit" ? "a case ended by COMMIT" : "a case ended by SET CONSTRAINTS and ROLLBACK"

/** The feature of a refusal at the commit, by the end that met it. */
export const refusedAtCommitBy = (end: End): EndFeature =>
	end === "commit" ? "a case refused at a real COMMIT" : "a case refused at its checked commit"

/**
 * Where a case's transaction starts on its seat: `empty`, the seat holding no row, as the case's own clone holds none; or
 * `replaced`, its rows first replaced by the state `before` (replaced), whose rows, and whatever the case commits over
 * them, the case's next replacement empties.
 */
export type Start<S> =
	| { readonly kind: "empty" }
	| { readonly kind: "replaced"; readonly before: S }

/**
 * One transaction of `statements` on a seat, ended as `end` says (End), with `read` of what it left or committed: what a
 * real COMMIT leaves stays on the case's own clone, which no later case takes.
 */
export const ended = <A>(
	seat: Seat,
	statements: ReadonlyArray<string>,
	end: End,
	read: Effect.Effect<A, SqlError>
): Effect.Effect<Checked<A>, SqlError | TransactionRolledBack> =>
	end === "checked"
		? attemptChecked(seat.session, statements, read)
		: Effect.gen(function* () {
				const real = yield* attempt(seat.session, statements)
				if (real.kind === "refused") {
					return real
				}
				const found = yield* read
				return { kind: "committed", read: found } satisfies Checked<A>
			})
