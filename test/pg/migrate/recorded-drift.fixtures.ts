/** What the properties of recorded-drift.test.ts read: their space, their schema and the planted changes. */

import { ChunkView } from "@bjornpagen/grizzle-text/chunks"
import { assert, defined } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { DefinedBy, DriftMismatch } from "#adapter/admission/drift.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { filed } from "#compiler/deploy/render/filed.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { installed, type ManifestObject } from "#compiler/deploy/snapshot/objects.ts"
import type { PhysicalKind } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	derived,
	login,
	on,
	relation,
	role,
	schema,
	wholeEntriesOf,
	wholeWritesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { ObjectName, PlFunction } from "#compiler/sql/ast.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"
import { Id } from "#test/support/ids.ts"

/**
 * What a case plants after the installation's migration, as its owner: nothing; a PL/pgSQL function of one kind created
 * again with another source under its own header; the roster's names constant renamed, so the snapshot's is missing and
 * the database holds one it does not name; a constant the snapshot does not name created; or the names constant's
 * header changed, the constant made STABLE.
 */
export const plants = [
	"nothing planted",
	"a source edited",
	"a constant renamed",
	"a stray constant",
	"a constant's header"
] as const
export type Plant = (typeof plants)[number]

/** The PL/pgSQL functions a source edit picks among, by their manifest kind: each kind the schema installs. */
export const editedKinds = [
	"ruleJudge",
	"lawFunction",
	"refusalFunction",
	"borrowFunction",
	"isolationFunction"
] as const
type EditedKind = (typeof editedKinds)[number]

/** A case: its plant, and for an edited source, the kind of function edited. */
export type DriftCase =
	| { readonly plant: Exclude<Plant, "a source edited"> }
	| { readonly plant: "a source edited"; readonly kind: EditedKind }

export type RecordedFeature =
	| Plant
	| `a source edited: ${EditedKind}`
	| "a source holding a control character"
	| "a constant missing"
	| "a constant unexpected"
	| "a constant differs"

/** Every case: each plant once, an edited source once for each kind of function. */
export const caseSpace = finite((source): DriftCase => {
	const plant = source.draw(element(plants))
	return plant === "a source edited"
		? { plant, kind: source.draw(element(editedKinds)) }
		: { plant }
})

/** A note text that may hold a tab, which a rule over a query compares with a literal holding one. */
const noteText = str.regex("^[a-z\\t]{0,8}$", "u")

/**
 * The schema of a case under `name`: Fact(id, k, kind, note), its kind a roster's closed id, T(k), and Tabbed, the k
 * of each fact whose note is `a<TAB>b`, contained in T: a rule over a query, whose rule judge and captures are PL/pgSQL
 * functions whose source holds the tab, and the roster's names constant. One login `desk` writes and reads every
 * relation.
 */
export const versionOf = (name: string) => {
	const Kind = closed.ordered("Kind", ["plain", "tabbed"])
	const Fact = relation("Fact", { id: Id, k: pg.integer, kind: closedId(Kind), note: noteText }, [
		"id"
	])
	const T = relation("T", { k: pg.integer }, ["k"])
	const Base = schema(name, [Kind, Fact, T], [])
	const Tabbed = derived(
		"Tabbed",
		query(Base).rule((r) => {
			const { k, note } = v(Fact, "fact")
			return r.match(Fact, { k, note }).where(r.eq(note, "a\tb")).find({ k })
		})
	)
	const s = schema.extend([Base], `${name}_1`, [Tabbed], [contained(on(Tabbed, "k"), on(T, "k"))])
	const writer = role(s, "writer", wholeEntriesOf(s), wholeWritesOf(s))
	return { schema: s, logins: [login(s, "desk", [writer])] }
}

/** The installation's objects of `kind`, its compile's, every statement whole. */
const objectsOf = (installation: Installation, kind: PhysicalKind): ReadonlyArray<ManifestObject> =>
	Arr.filter(installation.manifest.objects, (o) => o.kind === kind)

/** The CREATE FUNCTION of a PL/pgSQL object, as its compile installs it. */
const plFunctionOf = (o: ManifestObject): PlFunction => {
	const [create] = o.ddl
	assert.ok(
		create?.kind === "createFunction" && create.language === "plpgsql",
		`the PL/pgSQL function of ${o.ident}`
	)
	return create
}

/** The first object of `kind`, which the case's schema installs. */
const firstOf = (installation: Installation, kind: PhysicalKind): ManifestObject =>
	defined(objectsOf(installation, kind)[0], `an object of kind ${kind}`)

/** The roster's names constant, the first constant the installation creates. */
export const namesConstant = (installation: Installation): ObjectName => {
	const v = installed(firstOf(installation, "constant"))
	assert.ok(v.kind === "constant", "the roster's names constant")
	return v.create.name
}

/** A function by its name with no argument, as ALTER FUNCTION and DROP FUNCTION name it. */
const noArgs = (fn: ObjectName): string => `${printObjectName(fn)}()`

/**
 * The function a case edits, with the statements that plant it and the source it ends at: its definition as PostgreSQL
 * deparses it, created again with a comment line added to its source after its BEGIN, which leaves its header as it was.
 */
export interface Edit {
	readonly function: ObjectName
	readonly create: PlFunction
}

/** The PL/pgSQL function of `kind` a case edits. */
export const editOf = (installation: Installation, kind: EditedKind): Edit => {
	const create = plFunctionOf(firstOf(installation, kind))
	return { function: create.name, create }
}

/** The SQL that edits a function's source as PostgreSQL holds its definition: `definition` with a comment line after its
 * first BEGIN. */
export const editedDefinition = (definition: string): string => {
	const at = Str.indexOf("\nBEGIN\n")(definition)
	assert.ok(
		Option.isSome(at),
		"a PL/pgSQL definition begins its block with BEGIN on a line of its own"
	)
	return `${Str.slice(0, at.value + "\nBEGIN\n".length)(definition)}  -- planted by hand\n${Str.slice(at.value + "\nBEGIN\n".length)(definition)}`
}

/** The SQL that renames a constant, plants one, or changes one's header. */
export const constantPlants = {
	renamed: (fn: ObjectName) =>
		`ALTER FUNCTION ${noArgs(fn)} RENAME TO ${quoteIdent(`${fn.name}_moved`)}`,
	stray: (schemaName: string) =>
		`CREATE FUNCTION ${quoteIdent(schemaName)}."__stray_constant"() RETURNS integer[] LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN '{}'::integer[]`,
	header: (fn: ObjectName) => `ALTER FUNCTION ${noArgs(fn)} STABLE`
} as const

/**
 * The committed statement that defines `create`, read off the applied folders apart from the drift check: the newest
 * folder's last file holding, as `grizzle check` splits it, a statement whose text holds the function's CREATE as the
 * draft files it, its number counted from 1 in its file.
 */
export const definingStatement = (
	folders: ReadonlyArray<FolderTexts>,
	create: PlFunction
): DefinedBy => {
	const text = filed(printStatement(create))
	for (const folder of Arr.reverse(folders)) {
		for (const file of Arr.reverse(folder.files)) {
			const at = Arr.findLastIndex(splitStatements(new ChunkView(file.text)), (s) =>
				Str.includes(text)(s)
			)

			if (Option.isSome(at)) {
				return { kind: "statement", folder: folder.name, file: file.name, statement: at.value + 1 }
			}
		}
	}
	return { kind: "none" }
}

/** The mismatches a refused reapply names: its Drifted's; any other refusal fails the case. */
export const driftedOf = (failure: MigrateError): ReadonlyArray<DriftMismatch> => {
	const reason = failure.reason
	assert.ok(reason._tag === "Drifted", `the reapply refuses at the stage drift: ${failure.message}`)
	return reason.mismatches
}

/** Whether a mismatch of `kind` names `name`. */
export const names = (
	mismatches: ReadonlyArray<DriftMismatch>,
	kind: DriftMismatch["kind"],
	name: string
): boolean => Arr.some(mismatches, (m) => m.kind === kind && Str.includes(name)(m.fact))

/** The installed source digests PostgreSQL computes of every PL/pgSQL function of `schemaName`, by function name. */
export const installedSourcesQuery =
	"SELECT p.proname::text, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang WHERE n.nspname = $1::text AND l.lanname = 'plpgsql' ORDER BY 1"

/** Whether `installation` installs a PL/pgSQL function whose source holds a tab. */
export const holdsControlCharacter = (installation: Installation): boolean =>
	Arr.some(installation.manifest.objects, (o) =>
		Arr.some(
			o.ddl,
			(s) =>
				s.kind === "createFunction" &&
				s.language === "plpgsql" &&
				Str.includes("\t")(printStatement(s))
		)
	)
