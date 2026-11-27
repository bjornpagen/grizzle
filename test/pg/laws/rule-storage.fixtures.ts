/** What rule-storage.test.ts reads: its schema, its template, its space and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, String as Str } from "effect"
import { blockSize } from "#compiler/core/page.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** The byte bound of Tag's label: every field of Tag bounded, so its widest row fits one heap tuple. */
const labelBytes = 1024

/** A document, its body a text of no bound, so a delta of it may take a value no row holds. */
const Doc = relation("Doc", { id: pg.integer, body: str.regex("^.*$", "su") }, ["id"])

/** A tag, its label a text of at most labelBytes bytes, so a delta of it holds every value in its row. */
const Tag = relation(
	"Tag",
	{ id: pg.integer, label: str.bytes(labelBytes, str.regex("^.*$", "su")) },
	["id"]
)

/** The ids the derived relations join each of Doc and Tag with. */
const Known = relation("Known", { id: pg.integer }, ["id"])

/**
 * The schema under `name`: Doc, Tag and Known stored, and a rule over each of Doc's and Tag's joins with Known, so the
 * judge captures each of Doc's and Tag's writes into a delta of its whole heading (physical/ddl/rules.ts addRules).
 */
const storageSchema = (name: string) => {
	const Base = schema(name, [Doc, Tag, Known], [])
	const Docs = derived(
		"Docs",
		query(Base).rule((r) => {
			const { id } = v(Doc, "d")
			return r.match(Doc, { id }).match(Known, { id }).find({ id })
		})
	)
	const Tags = derived(
		"Tags",
		query(Base).rule((r) => {
			const { id } = v(Tag, "t")
			return r.match(Tag, { id }).match(Known, { id }).find({ id })
		})
	)
	return schema.extend(
		[Base],
		`${name}_1`,
		[Docs, Tags],
		[
			check("DocsCounted", Docs, (d) => d.ge(d.id, 0)),
			check("TagsCounted", Tags, (t) => t.ge(t.id, 0))
		]
	)
}

/** The schema installed through its first migration with no login. */
export const storageTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "rule storage",
	content: { schema: "RuleStorage", logins: [] },
	versions: [{ schema: storageSchema("RuleStorage"), declarations: noDeclarations }],
	options: {
		label: "rule_storage",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** How long a case's values are: a few bytes, or past a page, each value distinct hex digits pglz finds no repeat in. */
type Length = "short" | "past a page"

/** A case: how long the Doc's body is, and the Tag's label, which never passes its bound. */
export interface Writes {
	readonly body: Length
	readonly label: "short" | "at its bound"
}

export const writesGen: Gen<Writes> = (s) => ({
	body: s.draw(element<Length>(["short", "past a page"])),
	label: s.draw(element<Writes["label"]>(["short", "at its bound"]))
})

export type StorageFeature = "a body past a page" | "a label at its bound"

/** `bytes` hex digits of distinct SHA-256 digests of `seed`, an expression in SQL. */
const hexText = (seed: string, bytes: number): string =>
	`pg_catalog.left((SELECT pg_catalog.string_agg(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${seed} || ':' || j, 'UTF8')), 'hex'), '') FROM pg_catalog.generate_series(1, ${String(Math.ceil(bytes / 64))}) AS j), ${String(bytes)})`

/** The bytes of a value of `length`: past a page, one page and a half; short, eight. */
const bytesOf = (length: "short" | "past a page" | "at its bound"): number => {
	switch (length) {
		case "short":
			return 8
		case "past a page":
			return blockSize + blockSize / 2
		case "at its bound":
			return labelBytes
	}
}

/** Each of the session's deltas, by its name, with whether PostgreSQL made it a TOAST table. */
const deltas = (session: RawSession) =>
	Effect.map(
		session.values(
			"SELECT c.relname, c.reltoastrelid <> 0 FROM pg_catalog.pg_class AS c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relkind = 'r' AND c.relname LIKE '\\_\\_delta\\_%' ORDER BY c.relname",
			[]
		),
		(rows) => Arr.map(rows, (row) => ({ name: String(row[0]), toasted: row[1] === true }))
	)

class Stored extends Data.TaggedError("Stored")<{ readonly message: string }> {}

/**
 * Writes the case's Doc and Tag, each with the Known row its join needs, in one transaction its COMMIT judges, and reads
 * the deltas the judge's captures stood up: the COMMIT is accepted, a delta of Doc, whose body has no bound, takes its
 * body past a page through its TOAST table, and a delta of Tag, every field of whose widest row fits one heap tuple, is
 * one relation with no TOAST table, its every value in its row (sql/ast.ts SessionTableStorage).
 */
export const runWrites = (
	installed: Installed,
	session: RawSession,
	k: Writes,
	c: Case<StorageFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const where = Formatter.format(k)
		yield* session.begin
		yield* session.query(`INSERT INTO ${names.table(Known)} (id) VALUES (1)`, [])
		yield* session.query(
			`INSERT INTO ${names.table(Doc)} (id, body) VALUES (1, ${hexText("'body'", bytesOf(k.body))})`,
			[]
		)
		yield* session.query(
			`INSERT INTO ${names.table(Tag)} (id, label) VALUES (1, ${hexText("'label'", bytesOf(k.label))})`,
			[]
		)
		yield* session.commit
		if (k.body === "past a page") {
			c.note("a body past a page")
		}
		if (k.label === "at its bound") {
			c.note("a label at its bound")
		}
		const stood = yield* deltas(session)
		const ofDoc = Arr.filter(stood, (d) => Str.includes("_doc_")(d.name))
		const ofTag = Arr.filter(stood, (d) => Str.includes("_tag_")(d.name))
		if (!Arr.isReadonlyArrayNonEmpty(ofDoc) || !Arr.isReadonlyArrayNonEmpty(ofTag)) {
			return yield* new Stored({
				message: `the judge stood up no delta of Doc or of Tag: ${Formatter.format(stood)}, ${where}`
			})
		}
		if (Arr.some(ofDoc, (d) => !d.toasted)) {
			return yield* new Stored({
				message: `a delta of Doc, whose body has no bound, has no TOAST table: ${Formatter.format(ofDoc)}, ${where}`
			})
		}
		if (Arr.some(ofTag, (d) => d.toasted)) {
			return yield* new Stored({
				message: `a delta of Tag, whose widest row fits a heap tuple, has a TOAST table: ${Formatter.format(ofTag)}, ${where}`
			})
		}
	})
