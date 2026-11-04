import { Array as Arr, Record as Rec, Result, String as Str } from "effect"
import type { AdmissionMismatch, CatalogRowRefused } from "#adapter/errors/failures.ts"
import { type CatalogQuery, catalogRow, catalogRows } from "#adapter/wire/statement.ts"
import type { TemplateRequirements } from "#compiler/ir/products.ts"
import { vectorExtension } from "#compiler/physical/vector/storage.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import * as C from "#compiler/sql/catalog.ts"
import { emitCatalog } from "#compiler/sql/emit.ts"

/**
 * C.UTF-8 under any spelling of that locale: "C.", then "UTF" with an optional "-", then "8", ASCII letters in either
 * case. A hand-written scan; nothing under src runs a RegExp (test/unit/deps).
 */
const asciiLower = (text: string): string =>
	Arr.join(
		Arr.map(Str.split("")(text), (unit) =>
			unit >= "A" && unit <= "Z" ? Str.toLowerCase(unit) : unit
		),
		""
	)

/**
 * What Db.open requires of the server and the database before it yields, beside the ledger, the login and the role
 * (admit.ts):
 *
 * - the server is PostgreSQL 19 (server_version_num in [190000, 200000));
 * - the database is UTF8 with the builtin locale provider at C.UTF-8, and pg_catalog.pg_c_utf8, the collation every
 *   collatable column and domain names, is the builtin one;
 * - each extension the schema needs is installed at its pinned version in the schema the compiled names expect:
 *   pgvector 0.8.7 in the vector schema when a relation or the schema's laws carry a vector column (`vector` 0.8.7 in
 *   `vector_ext` on the local cluster), compared with pg_extension.extversion and the namespace of
 *   pg_extension.extnamespace. A schema without vectors expects no extension and is admitted on a database that has
 *   none. The installed extensions are read whatever the schema needs and kept for the opened Db: a query can need an
 *   extension the stored relations do not, through a relation parameter's heading, and that capability is checked
 *   against them when the query compiles, before any SQL (`missingExtension`).
 *
 * This module is pure: the catalog statements, catalog-read ASTs the engine prints (sql/catalog.ts), each with the
 * parsing of its rows, and the comparator of the parsed rows against the expectation. Every literal is typed and nothing
 * the statements return can be NULL: datlocale, which is NULL for a libc database, is read through format('%s'), which
 * spells NULL as the empty string.
 */
export const isCUtf8 = (observed: string): boolean => {
	const lower = asciiLower(observed)
	return lower === "c.utf-8" || lower === "c.utf8"
}

interface ExtensionRequirement {
	readonly name: string
	/** The pinned version, compared with pg_extension.extversion. */
	readonly version: string
	/** The schema the compiled names place its objects in. */
	readonly schema: string
}

export interface AdmissionExpectation {
	/** PostgreSQL 19: server_version_num in [minVersion, maxVersion). */
	readonly minVersion: number
	readonly maxVersion: number
	readonly encoding: string
	/** pg_database.datlocprovider of the builtin provider. */
	readonly localeProvider: string
	readonly extensions: ReadonlyArray<ExtensionRequirement>
}

/** Whether the schema stores or computes a vector value, so the pgvector extension must be installed. */
const usesVector = (artifacts: SchemaArtifacts): boolean =>
	Arr.some(Rec.values(artifacts.laws.theory.relations), (r) =>
		Arr.some(r.heading, (c) => c.type.carrier === "vector")
	)

export const admissionExpectation = (artifacts: SchemaArtifacts): AdmissionExpectation => ({
	minVersion: 190000,
	maxVersion: 200000,
	encoding: "UTF8",
	localeProvider: "b",
	extensions: usesVector(artifacts)
		? [
				{
					name: vectorExtension.name,
					version: vectorExtension.version,
					schema: artifacts.names.vectorSchema
				}
			]
		: []
})

/**
 * The database's settings: the server version number, the database encoding, locale provider and builtin locale, and
 * the number of builtin pg_catalog.pg_c_utf8 collations.
 */
interface DatabaseRow {
	readonly version: string
	readonly encoding: string
	readonly localeProvider: string
	readonly locale: string
	readonly cUtf8Collations: string
}

const database = C.from("pg_database", "d")
const collation = C.from("pg_collation", "c")

/** One row. */
export const databaseQuery: CatalogQuery<DatabaseRow> = {
	sql: emitCatalog(
		C.query(
			[
				C.asText(C.call("current_setting", [C.text("server_version_num")])),
				C.asText(C.call("pg_encoding_to_char", [database.col("encoding")])),
				C.asText(database.col("datlocprovider")),
				C.asText(C.call("format", [C.text("%s"), database.col("datlocale")])),
				C.asText(
					C.scalar(
						C.query(
							[C.countStar],
							[collation.item],
							C.and([
								C.eq(collation.col("collname"), C.literal("pg_c_utf8", "name")),
								C.eq(collation.col("collnamespace"), C.literal("pg_catalog", "regnamespace")),
								C.eq(collation.col("collprovider"), C.letter("b"))
							])
						)
					)
				)
			],
			[database.item],
			C.eq(database.col("datname"), C.call("current_database", []))
		)
	),
	what: "the database's settings",
	row: ([version, encoding, localeProvider, locale, cUtf8Collations]) =>
		version === undefined ||
		encoding === undefined ||
		localeProvider === undefined ||
		locale === undefined ||
		cUtf8Collations === undefined
			? undefined
			: { version, encoding, localeProvider, locale, cUtf8Collations }
}

/** An installed extension, the schema it lives in and its installed version. */
interface InstalledExtension {
	readonly name: string
	readonly schema: string
	readonly version: string
}

const extension = C.from("pg_extension", "e")
const namespace = C.from("pg_namespace", "n")

/** Every installed extension. */
export const extensionsQuery: CatalogQuery<InstalledExtension> = {
	sql: emitCatalog(
		C.select({
			...C.core(
				[
					C.asText(extension.col("extname")),
					C.asText(namespace.col("nspname")),
					C.asText(extension.col("extversion"))
				],
				[
					C.join(
						extension.item,
						namespace.item,
						C.eq(namespace.col("oid"), extension.col("extnamespace"))
					)
				],
				undefined
			),
			orderBy: [extension.col("extname")]
		})
	),
	what: "an extension, its schema and its version",
	row: ([name, schema, version]) =>
		name === undefined || schema === undefined || version === undefined
			? undefined
			: { name, schema, version }
}

/** The server's and the database's rows, parsed. */
export interface ServerRows {
	readonly database: DatabaseRow
	readonly extensions: ReadonlyArray<InstalledExtension>
}

/** Parses the rows of the database and extensions statements, as they answered them. */
export const serverRows = (rows: {
	readonly database: ReadonlyArray<ReadonlyArray<string>>
	readonly extensions: ReadonlyArray<ReadonlyArray<string>>
}): Result.Result<ServerRows, CatalogRowRefused> =>
	Result.all({
		database: catalogRow(databaseQuery, rows.database),
		extensions: catalogRows(extensionsQuery, rows.extensions)
	})

/** The installed extensions, by name, each with the schema it lives in. */
export const installedExtensions = (
	extensions: ReadonlyArray<InstalledExtension>
): ReadonlyMap<string, string> => new Map(Arr.map(extensions, (e) => [e.name, e.schema]))

/** Every mismatch between the server's rows and the expectation, in stage order; empty when they are admitted. */
export const serverMismatches = (
	rows: ServerRows,
	expectation: AdmissionExpectation
): ReadonlyArray<AdmissionMismatch> => {
	const out: Array<AdmissionMismatch> = []
	const db = rows.database

	const versionText = db.version
	const version = Number(versionText)
	if (
		!Number.isSafeInteger(version) ||
		version < expectation.minVersion ||
		version >= expectation.maxVersion
	) {
		out.push({
			stage: "version",
			check: "server_version_num",
			expected: `PostgreSQL 19 (${expectation.minVersion} <= server_version_num < ${expectation.maxVersion})`,
			observed: versionText
		})
	}

	if (db.encoding !== expectation.encoding) {
		out.push({
			stage: "locale",
			check: "database encoding",
			expected: expectation.encoding,
			observed: db.encoding
		})
	}
	if (db.localeProvider !== expectation.localeProvider) {
		out.push({
			stage: "locale",
			check: "database locale provider",
			expected: `${expectation.localeProvider} (builtin)`,
			observed: db.localeProvider
		})
	}
	if (!isCUtf8(db.locale)) {
		out.push({
			stage: "locale",
			check: "database builtin locale",
			expected: "C.UTF-8",
			observed: db.locale
		})
	}
	if (db.cUtf8Collations !== "1") {
		out.push({
			stage: "locale",
			check: "collation pg_catalog.pg_c_utf8 (builtin)",
			expected: "1",
			observed: db.cUtf8Collations
		})
	}

	const installed = new Map(Arr.map(rows.extensions, (e) => [e.name, e]))
	for (const e of expectation.extensions) {
		const at = installed.get(e.name)
		if (at === undefined || at.schema !== e.schema || at.version !== e.version) {
			out.push({
				stage: "capability",
				check: `extension ${e.name}`,
				expected: `version ${e.version} installed in schema ${e.schema}`,
				observed:
					at === undefined
						? "<not installed>"
						: `version ${at.version} installed in schema ${at.schema}`
			})
		}
	}
	return out
}

/**
 * The capability a compiled template needs and the admitted database lacks, as a CompileError capability text: the
 * first extension of the template's requirements that is not installed in the schema its compiled names place it in
 * (an absent capability found after admission). Undefined when every one is installed there.
 */
export const missingExtension = (
	requirements: Pick<TemplateRequirements, "extensions" | "extensionSchemas">,
	installed: ReadonlyMap<string, string>
): string | undefined => {
	for (const name of requirements.extensions) {
		const schema = requirements.extensionSchemas[name]
		const at = installed.get(name)
		if (at === undefined || (schema !== undefined && at !== schema)) {
			return schema === undefined ? `extension ${name}` : `extension ${name} in schema ${schema}`
		}
	}
	return undefined
}
