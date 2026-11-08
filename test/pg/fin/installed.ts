/**
 * The fin suites' seat: a schema of families installed through grizzle's own lowering, its first migration, beside the
 * physical names a direct writer addresses its rows by and its catalog's constraints, each described by the roles of
 * the columns it reads. A suite names what PostgreSQL refused by those roles, never by a name the naming door
 * allocated, so its verdicts read off what grizzle installed and nothing the suite restates.
 *
 * A column's role is its field's name for a field, and for a law column what its native says it holds: `‹n›` (a
 * family's copy of its owner's count), `‹i›` (a counted family's index), `‹ps›` (a tree's parent start), `‹before f.p›`
 * and `‹after f.p›` (fold f's plane p accumulators), and `‹gen x›` for a column generated from field x (a selected
 * group's guarded term, or a pred of the index or the count). A constraint is described by its kind, its relation and
 * its columns' roles in key order, a foreign key also by its target's, with its deferral and its update action as the
 * catalog states them, and the law the installation's constraint map says it reports.
 */
import { Array as Arr, Effect, Option, type Scope, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, installMigrated } from "#test/support/install-migrate.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { PgErrorFields, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

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
	/** The law the installation reports a violation of it as, if its constraint map holds it. */
	readonly law: Option.Option<LawId>
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

/** The role a law column holds, from the native that adds it. */
const lawColumnRole = (
	value: Extract<LawModel["natives"][number], { readonly namespace: "column" }>["object"]
): string => {
	if (value.value.kind === "generated") {
		return `‹gen ${value.field.name}›`
	}
	const d = value.value.draws
	switch (d.kind) {
		case "copy":
			return "‹n›"
		case "index":
			return "‹i›"
		case "parentStart":
			return "‹ps›"
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
WHERE s.nspname = $1 AND c.contype IN ('p', 'u', 'c', 'f')
UNION ALL
SELECT x.relname::text, r.relname::text, 'u', false, ' ',
	(SELECT string_agg(a.attname::text, E'\\x1f' ORDER BY k.o) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(n, o)
		JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n), '', ''
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
JOIN pg_catalog.pg_class r ON r.oid = i.indrelid
JOIN pg_catalog.pg_namespace s ON s.oid = r.relnamespace
WHERE s.nspname = $1 AND i.indisunique
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
	String(text) === "" ? [] : Str.split(String(text), SEP)

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
	schema: unknown,
	relations: Arr.NonEmptyReadonlyArray<string>,
	label: string
): Effect.Effect<Seat, CompileError | SqlError | TransactionRolledBack, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const installed = yield* installMigrated(schema, {
			ambient: ordinarySession,
			extensions: [],
			label: schemaLabelOf(label),
			logins: []
		})
		return yield* seatOfInstalled(installed, relations, label)
	})

/** The seat of an installation already made: its owner session and its catalog, read now. */
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
				native.namespace === "column" && native.object.relation.name === relation
					? [native.object]
					: []
			)
			const roles = Arr.map(lawColumns, lawColumnRole)
			for (const [i, object] of lawColumns.entries()) {
				const role = Arr.getUnsafe(roles, i)
				const shared = Arr.filter(roles, (r) => r === role).length > 1
				byColumn.set(object.column, shared ? familyRole(role, object) : role)
			}
			rolesByColumn.set(relation, byColumn)
		}
		const roleOf = (relation: string, column: string): string =>
			rolesByColumn.get(relation)?.get(column) ?? `?${column}`
		const rows = yield* substrate.admin.queryValues(catalogSql, [installed.schema])
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
					cascades: String(updtype) === "c",
					law: Option.fromUndefinedOr(
						constraintLaw(
							installed.installation.constraintToLaw,
							{ kind: "table", name: installed.names.relation(relation).name },
							String(name)
						)
					)
				}
			]
		})
		const session = yield* substrate.session({ ...ownerSession(), label })
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
 * A seat's one constraint matching `match`, or the defect of the suite naming every constraint it read, so a lowering
 * that installs another shape than the suite expects fails with what it installed.
 */
export const theConstraint = (
	seat: Seat,
	what: string,
	match: (c: Catalogued) => boolean
): Catalogued => {
	const found = Arr.filter(seat.constraints, match)
	const [one, ...more] = found
	if (one === undefined || more.length > 0) {
		throw new Error(
			`${seat.label}: ${found.length} constraints are ${what}, among ${Arr.join(Arr.map(seat.constraints, constraintText), "; ")}`
		)
	}
	return one
}

/**
 * Re-creates a foreign key without some of its pairs, in the same deferral and update action, as the owner: a mutant of
 * the installed lowering, with a UNIQUE over the target's remaining columns where no key of the target is exactly
 * those, since a foreign key's target must be, named by PostgreSQL, which picks a name no constraint holds. Each
 * statement runs in order; the suite never writes to the shared tree.
 */
export const droppedPairsSql = (
	seat: Seat,
	fk: Catalogued,
	dropped: (sourceRole: string, targetRole: string) => boolean
): ReadonlyArray<string> => {
	const target = Option.getOrThrow(fk.target)
	const pairs = Arr.filter(Arr.zip(fk.columns, target.columns), ([s, t]) => !dropped(s, t))
	const sources = Arr.map(pairs, ([s]) => seat.column(fk.relation, s))
	const targets = Arr.map(pairs, ([, t]) => seat.column(target.relation, t))
	const keyed = Arr.some(
		seat.constraints,
		(c) =>
			c.relation === target.relation &&
			(c.kind === "unique" || c.kind === "primary") &&
			sameRoles(
				c.columns,
				Arr.map(pairs, ([, t]) => t)
			)
	)
	return [
		`ALTER TABLE ${seat.table(fk.relation)} DROP CONSTRAINT ${quoteIdent(fk.name)}`,
		...(keyed
			? []
			: [
					`ALTER TABLE ${seat.table(target.relation)} ADD UNIQUE NULLS DISTINCT (${Arr.join(targets, ", ")})`
				]),
		`ALTER TABLE ${seat.table(fk.relation)} ADD CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY (${Arr.join(sources, ", ")}) REFERENCES ${seat.table(target.relation)} (${Arr.join(targets, ", ")}) MATCH SIMPLE${fk.cascades ? " ON UPDATE CASCADE" : ""}${fk.deferrable ? " DEFERRABLE INITIALLY DEFERRED" : " NOT DEFERRABLE"}`
	]
}

/** Drops one installed constraint, as the owner: a mutant of the installed lowering without it. */
export const droppedSql = (seat: Seat, c: Catalogued): string =>
	`ALTER TABLE ${seat.table(c.relation)} DROP CONSTRAINT ${quoteIdent(c.name)}`

/** Runs a mutant's DDL as the owner, then re-reads the seat's catalog, so its constraints are the mutant's. */
export const mutated = (
	seat: Seat,
	relations: Arr.NonEmptyReadonlyArray<string>,
	label: string,
	ddl: ReadonlyArray<string>
): Effect.Effect<Seat, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		for (const statement of ddl) {
			yield* substrate.admin.query(statement, [])
		}
		return yield* seatOfInstalled(seat.installed, relations, label)
	})

/** Removes every row of the relations in one SERIALIZABLE transaction, as the guard requires, so a case starts empty. */
export const cleared = (
	seat: Seat,
	relations: Arr.NonEmptyReadonlyArray<string>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.gen(function* () {
		yield* seat.session.begin
		yield* Effect.onError(
			seat.session.query(`TRUNCATE ${Arr.join(Arr.map(relations, seat.table), ", ")}`, []),
			() => Effect.ignore(seat.session.rollback)
		)
		yield* seat.session.commit
		yield* seat.session.resetStatements
	})
