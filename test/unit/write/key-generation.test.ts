/**
 * A relation whose primary key holds a key generation (ir/law.ts FieldWriting keyGenerated), h = Crypto.sha256(p) of a
 * text p no key may hold, is installed with h a column grizzle writes, never a GENERATED one, its generation proved by
 * the CHECK its primary key's law installs beside the PRIMARY KEY (laws/model/plan.ts keyGenerationCheck): PostgreSQL
 * refuses ON UPDATE CASCADE on a foreign key whose referencing columns hold a GENERATED column, which every family axis
 * over such a key is. Every write of it reads each fact's whole key: a member that states no h, R's own facts read by a
 * query or a computed insert, has its read compute h over the p it carries (write/insert/input.ts keyGeneratedRead),
 * and a put lowers to the statement it would over a key of written fields (write/put/choose.ts), R's own facts proved
 * stored ones through p, the field h's generation reads (write/put/proof.ts keyedBy). A lookup through R's key
 * (query/build/key.ts keyQuery, reader.get and a key member) states its key heads, p for h, and compares h with its
 * generation over them, so it reaches the row through the key's index; a general query stating p alone compares p
 * alone, no digest probe derived for it (main's ruling: only key reads apply the generation a key declares).
 *
 * The box: R(b, p, x, h), keyed by (b, h), mutable inside the unit of its b, written by a put of its own facts, alone or
 * beside a deletion, an enumerated put, or an insert computed from S(b, p, x); or keyed by (h, b) or (h), closed (no
 * unit's heading holds h, a field grizzle writes), written by that insert alone. The oracles: write/put/choose.ts's rules as they
 * read a key of written fields (test/unit/write/put/choose.fixtures.ts expectedOf), and the installation's table and
 * constraints, h a plain column and one CHECK comparing it with its generation, and the lookup's key heads.
 *
 * Features: each put's statement, the computed insert.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Record, String as Str } from "effect"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { queryInput } from "#compiler/program/input.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { keyLookup } from "#compiler/query/build/key.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { draftedSql, realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	caseGen,
	changeSetOf,
	type Choice,
	comparesIn,
	expectedOf,
	type KeyFeature,
	keyHeadsOfR,
	schemaOf,
	textOnly
} from "#test/unit/write/key-generation.fixtures.ts"

type CreateTable = Extract<SqlStatement, { readonly kind: "createTable" }>

/** A key generation is a column grizzle writes, proved by its key's CHECK, and every write of its relation reads each fact's whole key, a put lowering as it would over a key of written fields. */
export const aKeyGenerationIsAColumnGrizzleWritesProvedByItsKeysCheckAndEveryWriteOfItsRelationReadsEachFactsWholeKey =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"updateFrom (existingKeys)",
			"deleteThenInsert (unproved)",
			"onConflictDoUpdate (enumerated)",
			"computed insert"
		] satisfies ReadonlyArray<Reached<KeyFeature>>,
		check:
			(_, c: Case<KeyFeature>) =>
			({ primary, form }) =>
				Effect.sync(() => {
					assert.deepEqual(
						Arr.sort(Record.keys(keyHeadsOfR), Order.String),
						["b", "p"],
						"R's key is named by its heads"
					)
					const keyed = schemaOf(primary)
					const owned = owning(keyed.s)
					const installation = succeeded(
						compileInstallation(owned, installOptions(owned)),
						"R's installation"
					)
					const table = defined(
						Option.getOrUndefined(
							Arr.findFirst(
								installation.statements,
								(s): s is CreateTable =>
									s.kind === "createTable" && s.table.name === installation.names.relation("R").name
							)
						),
						"R's table"
					)
					const column = installation.names.column("R", "h")
					const h = defined(
						Option.getOrUndefined(Arr.findFirst(table.columns, (d) => d.name === column)),
						"h's column"
					)
					assert.equal(h.generated, undefined, "h is a column grizzle writes, no GENERATED one")
					const checks = Arr.filter(
						draftedSql(installation).statements,
						(sql) => Str.includes("CHECK")(sql) && Str.includes(`"${column}" = `)(sql)
					)
					assert.equal(checks.length, 1, "one CHECK compares h with its generation")
					const lookup = defined(keyLookup(keyed.s, keyed.R), "a lookup through R's key")
					assert.deepEqual<ReadonlyArray<string>>(
						Arr.sort(lookup.target.fields, Order.String),
						primary === "(h)" ? ["p"] : ["b", "p"],
						"a lookup through R's key states its heads, p for h"
					)
					assert.deepEqual<ReadonlyArray<string>>(
						Arr.map(lookup.target.generations, (g) => g.field),
						["h"],
						"a lookup through R's key compares h with its generation over its heads"
					)
					assert.equal(
						comparesIn(succeeded(queryInput(lookup.query), "the lookup's query").desc),
						lookup.target.fields.length + 1,
						"the lookup compares each head with its parameter and h with its generation over them"
					)
					assert.equal(
						comparesIn(succeeded(queryInput(textOnly(keyed)), "a text-only query").desc),
						1,
						"a general query stating p alone compares p alone: no digest probe is derived for it"
					)
					const compiled = succeeded(
						compileWrite(
							checking(keyed.s),
							descOf(changeSetOf(keyed, form)),
							realityWrite(succeeded(testArtifacts(keyed.s, testCompile)))
						),
						`a ${form} of R keyed by ${primary}`
					)
					if (form === "computed insert") {
						c.note("computed insert")
						return
					}
					const first = defined(compiled.choices[0], "R's first put's choice")
					const expected = expectedOf(form)
					assert.deepEqual<Choice>(
						{ target: first.target, reason: first.reason },
						expected,
						`${form} of R keyed by ${primary}`
					)
					c.note(`${expected.target} (${expected.reason})`)
				}),
		oracle: {
			kind: "specification",
			name: "choosePutTargets' rules over a key of written fields, and the key generation's column and CHECK"
		},
		box: "R(b, p, x, h = Crypto.sha256(p)), keyed by (b, h), mutable inside the unit of its b, put from its own facts alone or beside a deletion, put enumerated, or inserted from a query over S(b, p, x); or keyed by (h, b) or (h), closed, inserted from that query",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/tables.ts",
				original: '\t\tcase "generated":\n\t\t\treturn {\n\t\t\t\tkind: "stored",',
				replacement:
					'\t\tcase "generated":\n\t\tcase "keyGenerated":\n\t\t\treturn {\n\t\t\t\tkind: "stored",',
				why: "A key generation is installed GENERATED ALWAYS, which no foreign key over it can cascade through."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t\treturn [primaryKeyPlan(rel, d.key), ...(generations === undefined ? [] : [generations])]",
				replacement: "\t\t\treturn [primaryKeyPlan(rel, d.key)]",
				why: "The primary key installs no CHECK holding its key generation to its generation, so a wrong digest is stored."
			},
			{
				file: "packages/engine/src/write/put/statement.ts",
				original:
					"\tconst written = writtenFields(relation).filter(\n\t\t(f) => carried.includes(f) || generations.includes(f)\n\t)",
				replacement: "\tconst written = carried",
				why: "A put whose member states no key generation reads no h, so its statement names a column its input lacks."
			},
			{
				file: "packages/engine/src/write/insert/input.ts",
				original:
					'\trelation.primaryFields.filter((f) => f.writing.kind === "keyGenerated" && !carried.includes(f))',
				replacement: "\t[]",
				why: "An insert computed from a query writes h at a start it has none of."
			},
			{
				file: "packages/engine/src/query/build/key.ts",
				original: "\treturn { fields: [...new Set([...written, ...reads])], generations }",
				replacement: "\treturn { fields: key, generations: [] }",
				why: "A lookup through a key holding a key generation states the digest, which no caller holds, and compares nothing with its generation."
			},
			{
				file: "packages/engine/src/query/build/rule.ts",
				original: "\t\t\treturn ruleValue(ctx, matches, [...where, ...added], loc)",
				replacement: "\t\t\treturn ruleValue(ctx, matches, [...where, ...added, ...added], loc)",
				why: "A general query's rule holds a predicate its author never stated, as a derived digest probe would be."
			},
			{
				file: "packages/engine/src/write/put/proof.ts",
				original: "\t\t\t\t? fieldReads([f.writing.expr])\n\t\t\t\t: [f.name]",
				replacement: "\t\t\t\t? [f.name]\n\t\t\t\t: [f.name]",
				why: "R's own facts are no longer proved stored ones through p, so their put is the pair."
			}
		]
	})
