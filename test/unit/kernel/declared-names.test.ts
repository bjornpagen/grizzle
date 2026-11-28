/**
 * The naming door's byte limit on declared names (core/identity.ts parseDeclaredName): a declared name is admitted
 * exactly when its conversion, its segments lowercased and joined by single underscores, fits maxIdentifierBytes, and
 * an admitted name names its table by exactly that conversion, never cut. The oracle is the generator's own segments:
 * a name is spelled from words, acronyms and digit runs, each run of them joined so the door's boundary rule splits it
 * back into them (a capital after a lowercase letter, an acronym's last capital before a lowercase letter, a digit run
 * against a letter, an underscore), so the conversion is known before the door reads it. Lengths are steered to the
 * limit: a name's conversion ends at a drawn target byte count around 63, the last word sized to meet it.
 *
 * Every builder that takes a declared name for an object grizzle installs under its conversion (the dynamic door's
 * relations and rosters, derived relations, schemas and levels, contracts) refuses a name past the limit where it is
 * built, IdentifierTooLong naming the name, its conversion and the conversion's bytes, and builds one within it: no
 * value carries a name a later stage must refuse for a reason it cannot name (a closed id over a roster resolves its
 * roster by name). Same oracle, the generator's segments.
 *
 * Features: a conversion under the limit, at it, one byte past and far past, and two names at the limit apart; each
 * builder building a name and refusing one, and a name within the limit whose conversion passes it.
 *
 * A closed-id field is admitted where its relation is built exactly when its conversion fits closedIdFieldBytes,
 * PostgreSQL's identifier less `_name`, so the decoded column `<field>_name` each role view shows beside its code fits;
 * past it, DecodedColumnTooLong where the relation is built, naming the relation, the field, its conversion, its bytes and
 * the budget, never a refusal of a later stage. Any other field takes the identifier whole. The box: a closed id and a
 * plain field at every conversion from one under the budget to one past the identifier. Oracle: the budget, and the
 * conversion the box spells.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed, element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	closedIdFieldBytes,
	maxIdentifierBytes,
	conversionOf,
	identity,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import { lawsOf } from "#compiler/program/laws.ts"
import { relation as dynamicRelation } from "#compiler/public/dynamic.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { succeeded, throwsRefused } from "#test/support/assert.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	builderAims,
	type BuilderCase,
	builderCaseGen,
	type BuilderFeature,
	builtNamed,
	fieldNamedGen,
	type LimitFeature,
	nameBuilders,
	nameOf,
	pgSystemColumns,
	situationOf,
	type SystemColumnFeature,
	targetGen
} from "#test/unit/kernel/declared-names.fixtures.ts"

/**
 * The naming door's byte limit admits a declared name exactly when its conversion fits, and names its table by that
 * conversion, whole.
 *
 * Budget: its suite's count before the conversion (unit/kernel/declared-name-limit: 400 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const theNamingDoorsByteLimitAdmitsADeclaredNameExactlyWhenItsConversionFitsAndNamesItsTableByThatConversionWhole =
	property.explore(
		(source) =>
			[
				source.draw(nameOf(source.draw(targetGen))),
				source.draw(nameOf(source.draw(targetGen)))
			] as const,
		{
			needs: {},
			situations: [
				"under the limit",
				"at the limit",
				"one byte past",
				"far past",
				"two at the limit apart"
			] satisfies ReadonlyArray<Reached<LimitFeature>>,
			check: (_, c: Case<LimitFeature>) => (names) =>
				Effect.sync(() => {
					const identifiers = Arr.map(names, ({ declared, converted }) => {
						assert.equal(conversionOf(declared), converted, declared)
						const bytes = Buffer.byteLength(converted)
						c.note(situationOf(bytes))
						const parsed = parseDeclaredName(declared)
						assert.equal(parsed.ok, bytes <= maxIdentifierBytes, declared)
						if (!parsed.ok) {
							return undefined
						}
						const table = identity.table(parsed.value)
						assert.equal(table.form, "readable", declared)
						assert.equal<string>(table.identifier, converted, declared)
						return table.identifier
					})
					const [[a, b], [x, y]] = [names, identifiers]
					if (x !== undefined && y !== undefined) {
						assert.equal(x === y, a.converted === b.converted, `${a.declared} beside ${b.declared}`)
						if (
							x !== y &&
							Buffer.byteLength(x) === maxIdentifierBytes &&
							Buffer.byteLength(y) === maxIdentifierBytes
						) {
							c.note("two at the limit apart")
						}
					}
				}),
			oracle: {
				kind: "specification",
				name: "the generator's own segments, lowercased and joined by underscores, and the limit on their bytes"
			},
			budget: { runs: 400, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/identity.ts",
					original:
						'\treturn bytes > maxIdentifierBytes\n\t\t? Result.err({ kind: "length", conversion, bytes })',
					replacement:
						'\treturn bytes >= maxIdentifierBytes\n\t\t? Result.err({ kind: "length", conversion, bytes })',
					why: "A conversion of exactly maxIdentifierBytes is refused; the byte-limit property fails."
				},
				{
					file: "packages/engine/src/core/identity.ts",
					original:
						"\t\t\t\t(isUpper(ch) && isLower(prev)) ||\n\t\t\t\t(isUpper(ch) && isUpper(prev) && isLower(next)))",
					replacement: "\t\t\t\t(isUpper(ch) && isLower(prev)))",
					why: "An acronym's last capital stays with it before a lowercase letter (HTTPRoute one segment), so a conversion is not the generator's segments; the byte-limit property fails."
				}
			]
		}
	)

/**
 * Every builder of a declared name builds a name whose conversion fits the limit, and refuses one past it where it is
 * built: IdentifierTooLong naming the name, its conversion and the conversion's bytes.
 */
export const everyBuilderOfADeclaredNameBuildsOneWithinTheLimitAndRefusesOnePastItWhereItIsBuilt =
	property.explore(aimed<BuilderCase, BuilderFeature>(builderCaseGen, builderAims), {
		needs: {},
		situations: [
			...Arr.map(nameBuilders, (b) => `${b} built` as const),
			...Arr.map(nameBuilders, (b) => `${b} refused` as const),
			"at the limit",
			"one byte past",
			"far past",
			"a name within the limit whose conversion passes it"
		] satisfies ReadonlyArray<Reached<BuilderFeature>>,
		check:
			(_, c: Case<BuilderFeature>) =>
			([builder, { declared, converted }]) =>
				Effect.sync(() => {
					assert.equal(conversionOf(declared), converted, declared)
					const bytes = Buffer.byteLength(converted)
					const situation = situationOf(bytes)
					if (situation !== "under the limit") {
						c.note(situation)
					}
					if (bytes <= maxIdentifierBytes) {
						builtNamed(builder, declared)
						c.note(`${builder} built`)
						return
					}
					if (Buffer.byteLength(declared) <= maxIdentifierBytes) {
						c.note("a name within the limit whose conversion passes it")
					}
					const { reason } = throwsRefused(
						() => builtNamed(builder, declared),
						"IdentifierTooLong",
						`${builder} ${declared}`
					)
					if (reason._tag !== "IdentifierTooLong") {
						return assert.fail(`${builder} ${declared} is refused as IdentifierTooLong`)
					}
					assert.deepEqual(
						[reason.identifier, reason.bytes, reason.limit],
						[converted, bytes, maxIdentifierBytes],
						`${builder} ${declared}`
					)
					assert.ok(
						Str.includes(declared)(reason.declaration),
						`${builder}'s refusal names ${declared}: ${reason.declaration}`
					)
					c.note(`${builder} refused`)
				}),
		oracle: {
			kind: "specification",
			name: "the generator's own segments, lowercased and joined by underscores, and the limit on their bytes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/relation.ts",
				original: '\tconst rosterName = admittedName(name, naming, label, "roster")',
				replacement: '\tconst rosterName = requireName(name, label, "a roster name")',
				why: "closed.ordered and closed.unordered take any storable name, as they did: a roster past the limit builds, typed under no roster, and a closed id over it is refused when its schema compiles as no closed relation of its name, never as a name too long (metis's catalog-sync refusal); the builder property fails at a roster past the limit."
			}
		]
	})

/**
 * A relation's field is admitted exactly when its conversion is none of PostgreSQL's system columns: a schema whose
 * relation declares a field named after one, in any spelling whose conversion is the column's, is refused when it
 * compiles, MalformedDescription at the field, where PostgreSQL would refuse its table (42701); a
 * name one step from one, a digit after it, a letter before it or the column cut in two, is admitted, as is any other.
 */
export const aRelationsFieldIsAdmittedExactlyWhenItsConversionIsNoneOfPostgreSQLsSystemColumns =
	property.explore(fieldNamedGen, {
		needs: {},
		situations: [
			...Arr.map(pgSystemColumns, (c) => `${c} refused` as const),
			"admitted"
		] satisfies ReadonlyArray<Reached<SystemColumnFeature>>,
		check: (_, c: Case<SystemColumnFeature>) => (field) =>
			Effect.sync(() => {
				assert.equal(conversionOf(field.declared), field.converted, field.declared)
				const owned = ownedInput(
					schema("Named", [relation("R", { id: int4, [field.declared]: int4 }, ["id"])], [])
				)
				const system = Arr.findFirst(pgSystemColumns, (s) => s === field.converted)
				if (system._tag === "None") {
					assert.equal(owned.ok ? undefined : owned.error.reason, undefined, field.declared)
					c.note("admitted")
					return
				}
				if (owned.ok) {
					return assert.fail(`a field ${field.declared} is refused`)
				}
				const reason = owned.error.reason
				assert.equal(reason._tag, "MalformedDescription", field.declared)
				if (reason._tag !== "MalformedDescription") {
					return
				}
				assert.deepEqual(reason.at.path, ["R", field.declared], "the refusal is at the field")
				c.note(`${system.value} refused`)
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL 19's system columns, as src/backend/catalog/heap.c's SysAtt spells them, which a table refuses a column of (42701)"
		},
		budget: { runs: 200, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: "\t\treturn new DeclaredNamespace(what, systemColumns)",
				replacement: "\t\treturn new DeclaredNamespace(what, noneHeld)",
				why: "A relation's columns hold no system column, so a field named cmax compiles and PostgreSQL refuses its table (42701); the system-column property fails."
			}
		]
	})

/** The roster a box's closed-id field is over. */
const Shade = closed.unordered("Shade", ["Light", "Dark"])

/** What a cell of the closed-id box reaches: its kind of field, and whether its relation is built. */
type DecodedFeature = "a closed id built" | "a closed id refused" | "a plain field built"

/**
 * A closed-id field is admitted where its relation is built exactly when its decoded column fits PostgreSQL's
 * identifier; past it, DecodedColumnTooLong there, naming the relation, the field, its conversion and the budget.
 */
export const aClosedIdFieldIsAdmittedExactlyWhenItsDecodedColumnFitsAndRefusedWhereItsRelationIsBuilt =
	property.exhaust(
		finite((source) => ({
			closedField: source.draw(element([true, false] as const)),
			bytes: source.draw(int(closedIdFieldBytes - 1, maxIdentifierBytes))
		})),
		{
			needs: {},
			situations: [
				"a closed id built",
				"a closed id refused",
				"a plain field built"
			] satisfies ReadonlyArray<Reached<DecodedFeature>>,
			check:
				(_, c: Case<DecodedFeature>) =>
				({ closedField, bytes }) =>
					Effect.sync(() => {
						const field = `f${Str.repeat(bytes - 1)("x")}`
						assert.equal(Buffer.byteLength(conversionOf(field)), bytes, field)
						const build = () =>
							dynamicRelation(
								"Swatch",
								{ id: int4, [field]: closedField ? closedId(Shade) : int4 },
								["id"]
							)
						if (closedField && bytes > closedIdFieldBytes) {
							const { reason } = throwsRefused(build, "DecodedColumnTooLong", field)
							if (reason._tag !== "DecodedColumnTooLong") {
								return assert.fail(`${field} is refused as DecodedColumnTooLong`)
							}
							assert.deepEqual(
								[reason.relation, reason.field, reason.conversion, reason.bytes, reason.limit],
								["Swatch", field, field, bytes, closedIdFieldBytes],
								field
							)
							c.note("a closed id refused")
							return
						}
						const built = build()
						lawsOf(schema("Swatches", [Shade, built], []))
						if (closedField) {
							const declared = succeeded(parseDeclaredName(field), field)
							assert.ok(
								Buffer.byteLength(identity.decodedColumn(declared).identifier) <=
									maxIdentifierBytes,
								`${field}'s decoded column fits`
							)
						}
						c.note(closedField ? "a closed id built" : "a plain field built")
					}),
			oracle: {
				kind: "specification",
				name: "the budget, PostgreSQL's identifier less _name, and the conversion the box spells"
			},
			box: "a closed id and a plain field at every conversion from one byte under the closed id's budget to the identifier's whole",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/identity.ts",
					original: "\treturn bytes > closedIdFieldBytes\n\t\t? Result.err(",
					replacement: "\treturn bytes > maxIdentifierBytes\n\t\t? Result.err(",
					why: "A closed-id field is held to the identifier's whole bytes, not its decoded column's: a field of 59 to 63 bytes builds, and its decoded column passes PostgreSQL's identifier."
				}
			]
		}
	)
