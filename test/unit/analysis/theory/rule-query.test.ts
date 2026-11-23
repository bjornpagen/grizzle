/**
 * Rules over queries compile whenever the schema builders admit them: the violation query and every trigger probe of
 * a rule whose side reads a derived relation are descriptions grizzle writes itself, so the checker refusing one is
 * grizzle's defect, never the schema's.
 *
 * The box is every rule of four kinds (a containment into the derived relation, one out of it, and a check over it
 * under a name of its own or under the name of Item's own check, a table it reads) over a derived relation of Item,
 * read directly or through Item's semijoin with it, binding its own id by a variable or by a literal. The definition
 * binds Item's kind by a variable or a literal, may join a Mark row whose id and on it binds by a variable or a literal,
 * and may negate a Mark row of the item, binding its on by a literal or not at all: each probe site a literal binding
 * reaches, a match's pinned key, a withdrawn match's field, an anti-join's binding and a match of a derived relation
 * inlined in another's definition.
 *
 * A second box correlates texts of different refinements: a containment into or out of a derived relation of Doc,
 * read directly or through Doc's semijoin with it, between Doc's path and a Ref's of the same, a narrower or a wider
 * pattern, the definition negating a Note of the doc's path of each of those patterns or none. Equality of two texts is
 * the equality of their bytes whatever patterns refine them, so each correlation is admitted, as a stored foreign key
 * between them is.
 *
 * A third box reads a head literal: a derived relation of Item whose two arms deliver a text or a Decimal as a
 * JavaScript literal, one in both or one each, the union's discriminant, read directly and through Item's semijoin with
 * it binding it by a variable a stored match binds, by a literal, or by a variable minted from the relation itself,
 * which only the head literal defines, under a check, a key and a selection that read it, and a containment into it,
 * on its pair or on its id alone, the semijoin's definition then fixing the stored column it reads to the literal. The
 * Decimal is finite, NaN, an infinity, or one past every numeric(p, s), of one integer digit more than its greatest
 * precision or one fraction digit more than its greatest scale. A
 * bare head literal takes its column's type, a Decimal's the computed numeric of the bound its analysis proves, which
 * no numeric(p, s) states for any but the finite one, so it stands wherever a term of the column does; a variable only
 * a head literal defines is that literal. A trigger probe reads the union by arm, so a fact of one arm meets each arm's
 * literal: bound to it where the arm delivers the same literal, compared with it in the arm's own query where the arm
 * delivers another (analysis/theory/query.ts Meeting), since a literal bound where the arm delivers another is a filter
 * no fact of the arm meets, which the checker refuses. A selection over Read compares Read's amount, Amount's
 * numeric(4, 2), with the bare literal, which takes that type as written: an infinity, or one past its precision or
 * scale, is refused for it (scalar/compute/literal.ts oppositeLiteralProblem), never rounded or compared at another.
 *
 * A fourth box negates: a derived relation of Item whose definition negates Mark, a join of Mark and Note (a query),
 * their union (a query of two rules), the join derived on a level below, a query that aggregates or one that negates in
 * turn, alone among its filters, inside a conjunction or inside a conjunction nested in one, binding Mark's on by a
 * literal or not at all, read itself or through Item's semijoin with it under a containment into it, one out of it, a
 * check and a key. A negation of select-project-join arms is admitted, the conjunction's included, and so is a negation
 * of an aggregate, whose groups a probe reads where a write touches them (analysis/theory/query.ts GroupedMatch).
 *
 * The oracle is the builders' admission: a schema schema.extend builds compiles to its artifacts, and its laws'
 * violation queries are written as generate writes them, each rule's checked there (laws/model/violations.ts
 * theoryViolations). Beside it, each name a
 * table holds a constraint or a rule's trigger under reports one law, since PostgreSQL reports a violation by its table
 * and that name alone: a check over the derived relation, under its own name or Item's check's, is held under a name of
 * its law's.
 *
 * Features: each rule kind and each literal binding site for the first box; each pattern relation and negated note for
 * the second; each literal kind, arm placement and reader for the third; each negated source, placement and reader,
 * admitted and refused, for the fourth.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import {
	amountSchemaOf,
	clashesOf,
	compiledOf,
	computedCase,
	type ComputedReached,
	computedSchemaOf,
	decimalOf,
	negatedSources,
	negationCase,
	type NegationReached,
	negationSchemaOf,
	type Reached,
	ruleCase,
	schemaOf,
	tagCase,
	type TagReached,
	tagSchemaOf,
	textCase,
	type TextReached,
	textSchemaOf
} from "#test/unit/analysis/theory/rule-query.fixtures.ts"

/** A rule over a query compiles whenever the builders admit it, a literal bound anywhere in a definition it reads. */
export const aRuleOverAQueryCompilesWheneverTheBuildersAdmitItALiteralBoundAnywhereInADefinitionItReads =
	property.exhaust(finite(ruleCase), {
		needs: {},
		situations: [
			"a literal kind",
			"a literal mark id",
			"a literal mark on",
			"a literal negated on",
			"a literal read id",
			"into",
			"out of",
			"check",
			"check named as Item's"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, k: Case<Reached>) => (c) =>
			Effect.sync(() => {
				k.note(c.rule)
				if (c.kind === "literal") {
					k.note("a literal kind")
				}
				if (c.joined !== "none" && c.joined.id === "literal") {
					k.note("a literal mark id")
				}
				if (c.joined !== "none" && c.joined.on === "literal") {
					k.note("a literal mark on")
				}
				if (c.negated === "literal") {
					k.note("a literal negated on")
				}
				if (c.read === "literal") {
					k.note("a literal read id")
				}
				const compiled = compiledOf(schemaOf(c))
				assert.deepEqual(
					compiled.ok ? undefined : compiled.error.reason,
					undefined,
					`the builders admit ${Formatter.format(c)}, and its compilation refuses it`
				)
				assert.deepEqual(
					compiled.ok ? clashesOf(compiled.value.laws.constraints) : [],
					[],
					`each constraint or trigger name of ${Formatter.format(c)} names one law on its table`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the builders' admission: a schema schema.extend builds compiles to its artifacts"
		},
		box: "every containment into, containment out of and check over a derived relation of Item, the check named apart or as a check of Item, read itself or through a semijoin binding its id by a variable or a literal, whose definition binds kind, a joined Mark's id and on, and a negated Mark's on each by a variable or a literal",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original:
					'\t...Object.values(owned.relations).flatMap((r): ReadonlyArray<Identity<IdentityKind>> => [\n\t\t...installedIdentity(r),\n\t\t...Object.values(r.fields).map((f) => f.named),\n\t\t...r.keys.map((k) => k.named),\n\t\t...(r.kind === "relation" ? r.checks.map((c) => c.named) : [])\n\t])',
				replacement:
					'\t...Object.values(owned.relations).flatMap((r): ReadonlyArray<Identity<IdentityKind>> => [...Object.values(r.fields).map((f) => f.named), ...r.keys.map((k) => k.named), ...(r.kind === "relation" ? r.checks.map((c) => c.named) : [])])',
				why: "Operator mutant (element) at packages/engine/src/schema/own.ts:349 in ownedIdentities: `[\n\t\t...installedIdentity(r),\n\t\t...Object.values(r.fields).map((f) => f.named)` becomes `[...Object.values(r.fields).map((f) => f.named)`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original:
					'\t...Object.values(owned.relations).flatMap((r): ReadonlyArray<Identity<IdentityKind>> => [\n\t\t...installedIdentity(r),\n\t\t...Object.values(r.fields).map((f) => f.named),\n\t\t...r.keys.map((k) => k.named),\n\t\t...(r.kind === "relation" ? r.checks.map((c) => c.named) : [])\n\t])',
				replacement:
					'\t...Object.values(owned.relations).flatMap((r): ReadonlyArray<Identity<IdentityKind>> => [...Object.values(r.fields).map((f) => f.named), ...r.keys.map((k) => k.named), ...(r.kind === "relation" ? r.checks.map((c) => c.named) : [])])',
				why: "Operator mutant (element) at packages/engine/src/schema/own.ts:349 in ownedIdentities: `[\n\t\t...installedIdentity(r),\n\t\t...Object.values(r.fields).map((f) => f.named)` becomes `[...Object.values(r.fields).map((f) => f.named)`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/** A rule over a query compiles whenever the builders admit it, correlating texts of different patterns as a stored foreign key does. */
export const aRuleOverAQueryCompilesWheneverTheBuildersAdmitItCorrelatingTextsOfDifferentPatternsAsAStoredForeignKeyDoes =
	property.exhaust(finite(textCase), {
		needs: {},
		situations: [
			"a narrower ref",
			"a wider ref",
			"a narrower note",
			"a wider note",
			"into",
			"out of"
		] satisfies ReadonlyArray<ReachedOf<TextReached>>,
		check: (_, k: Case<TextReached>) => (c) =>
			Effect.sync(() => {
				k.note(c.rule)
				if (c.ref !== "same") {
					k.note(`a ${c.ref} ref`)
				}
				if (c.note !== "none" && c.note !== "same") {
					k.note(`a ${c.note} note`)
				}
				const compiled = compiledOf(textSchemaOf(c))
				assert.deepEqual(
					compiled.ok ? undefined : compiled.error.reason,
					undefined,
					`the builders admit ${Formatter.format(c)}, and its compilation refuses it`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the builders' admission: a schema schema.extend builds compiles to its artifacts"
		},
		box: "every containment into and out of Doc's paths, read itself or through a semijoin, against a Ref path of Doc's, a narrower or a wider pattern, the paths negating a Note path of each pattern or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tif (!sameCarrier(region.type, col.type)) {",
				replacement:
					"\t\tif (!sameCarrier(region.type, col.type) || typeLabel(region.type) !== typeLabel(col.type)) {",
				why: "A negated text correlated with a region text of another pattern refused, as the check c2f719c1 deleted refused it (check/checker.ts correlatedBinding); the second box fails."
			}
		]
	})

/**
 * The Decimals no numeric(4, 2) holds as written, which Read's selection, comparing Amount's numeric(4, 2) amount with
 * the bare literal, is refused for (scalar/compute/literal.ts oppositeLiteralProblem): the infinities, and one past
 * numeric(p, s)'s greatest precision or scale. NaN is a value of numeric(4, 2), and 1.5 is 1.50.
 */
const outsideAmount: ReadonlySet<string> = new Set([
	"Infinity",
	"-Infinity",
	"past precision",
	"past scale"
])

/** A rule over a query compiles whenever the builders admit it, a head literal read where a term of its column stands. */
export const aRuleOverAQueryCompilesWheneverTheBuildersAdmitItAHeadLiteralReadWhereATermOfItsColumnStands =
	property.exhaust(finite(tagCase), {
		needs: {},
		situations: [
			"text literal",
			"finite literal",
			"NaN literal",
			"Infinity literal",
			"-Infinity literal",
			"past precision literal",
			"past scale literal",
			"same tagging",
			"distinct tagging",
			"read by variable",
			"read by literal",
			"read by own",
			"check",
			"key",
			"selection",
			"into",
			"into id"
		] satisfies ReadonlyArray<ReachedOf<TagReached>>,
		check: (_, k: Case<TagReached>) => (c) =>
			Effect.sync(() => {
				k.note(`${c.literal} literal`)
				k.note(`${c.tagging} tagging`)
				k.note(`read by ${c.read}`)
				k.note(c.rule)
				const compiled = compiledOf(
					c.literal === "text" ? tagSchemaOf(c) : amountSchemaOf(c, decimalOf[c.literal])
				)
				if (c.literal !== "text" && c.rule === "selection" && outsideAmount.has(c.literal)) {
					assert.ok(
						!compiled.ok &&
							compiled.error.reason._tag === "MalformedDescription" &&
							Str.includes("numeric(4,2)")(compiled.error.message),
						`${Formatter.format(c)}: Read's selection compares Amount's numeric(4,2) with a literal no value of it, refused for it: ${compiled.ok ? "compiled" : compiled.error.message}`
					)
					return
				}
				assert.deepEqual(
					compiled.ok ? undefined : compiled.error.reason,
					undefined,
					`the builders admit ${Formatter.format(c)}, and its compilation refuses it`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the builders' admission: a schema schema.extend builds compiles to its artifacts"
		},
		box: "every check, key and selection over, and containment into, on its pair or its id alone, a derived relation of Item whose two arms deliver a text or Decimal head literal, the Decimal finite, NaN, an infinity, or one past numeric(p, s)'s greatest precision or scale, one in both or a discriminant, and over its semijoin binding it by a variable a stored match binds, a literal, or a variable only its head literal defines",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\thead[name] = mapLeaves(isBare(t) ? typedAs(t, columns(name)) : t, leaves)",
				replacement: "\t\t\thead[name] = mapLeaves(t, leaves)",
				why: "A bare head literal left untyped where a term of its column stands (analysis/theory/query.ts); the third box fails."
			}
		]
	})

/** A rule over a query compiles a negation of a table, a join, a union, a derived relation or a query that negates in turn, alone or in a conjunction, on either side of every rule, and refuses one of a query a rule may not read, by name. */
export const aRuleOverAQueryCompilesANegationOfATableAJoinAUnionADerivedRelationOrAQueryThatNegatesInTurnAloneOrInAConjunctionOnEitherSideOfEveryRuleAndRefusesOneOfAQueryARuleMayNotReadByName =
	property.exhaust(finite(negationCase), {
		needs: {},
		situations: [
			...Arr.map(negatedSources, (n) => `negates ${n}` as const),
			"negates alone",
			"negates conjunction",
			"negates nested conjunction",
			"a literal negated on",
			"into",
			"out of",
			"check",
			"key",
			"into read through a semijoin",
			"out of read through a semijoin"
		] satisfies ReadonlyArray<ReachedOf<NegationReached>>,
		check: (_, k: Case<NegationReached>) => (c) =>
			Effect.sync(() => {
				k.note(`negates ${c.source}`)
				k.note(`negates ${c.placement}`)
				k.note(c.rule)
				if (c.literal) {
					k.note("a literal negated on")
				}
				if (c.read === "semijoin") {
					k.note(`${c.rule} read through a semijoin`)
				}
				const compiled = compiledOf(negationSchemaOf(c))
				assert.deepEqual(
					compiled.ok ? undefined : compiled.error.reason,
					undefined,
					`the builders admit ${Formatter.format(c)}, and its compilation refuses it`
				)
				assert.deepEqual(
					compiled.ok ? clashesOf(compiled.value.laws.constraints) : [],
					[],
					`each constraint or trigger name of ${Formatter.format(c)} names one law on its table`
				)
			}),
		oracle: {
			kind: "specification",
			name: "a rule over a query reads a negation of select-project-join arms, each of which may negate or aggregate in turn: a schema schema.extend builds compiles to its artifacts"
		},
		box: "every containment into and out of, check over and key over a derived relation of Item, read itself or through a semijoin, whose definition negates Mark, a join of Mark and Note, their union, the join derived, a query that aggregates or one that negates, alone, in a conjunction or in a conjunction nested in one, binding Mark's on by a literal or not at all",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\te.kind === "and" && holdsNegation(e) ? e.args.flatMap(filtersOf) : [e]',
				replacement: "\t[e]",
				why: "A conjunction holding a negation read whole, which refuses it as a negation below a condition (analysis/theory/query.ts filtersOf); the fourth box fails."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\t\treturn folds(rule.head)\n\t\t\t? [this.#groupedArm(relation, rule, groupFields(rule.head), columns)]\n\t\t\t: this.#conjunctive(relation, rule, columns)",
				replacement: "\t\treturn this.#conjunctive(relation, rule, columns)",
				why: "An aggregating rule read as a conjunctive arm, its folds refused as a head term no arm derives, as a rule over an aggregate was before the probes read its groups (analysis/theory/query.ts #rule); the fourth box fails at its negated aggregate."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\treturn { source: source.source, bindings, arms: source.arms }\n",
				replacement: `\t\tif (source.arms.some((arm) => arm.negated.length > 0)) {\n\t\t\tthis.#refuse(relation, \`negates \${negated}, which negates in turn\`)\n\t\t}\n\t\treturn { source: source.source, bindings, arms: source.arms }\n`,
				why: "A negated query that negates in turn refused as UnsupportedLawFamily, as it was before a probe read a relation under two negations (analysis/theory/query.ts negated); the fourth box fails."
			}
		]
	})

/**
 * A rule over a derived relation whose rules each negate a relation at a term an inlined definition computes compiles,
 * one rule or two, under every kind of rule: flattened, the negation binds the computed term, which the checker lowers
 * in a negation only once navigation has passed it in (analysis/theory/navigate.ts #filtered, check/checker.ts
 * #negatedTerm). A write of the negated relation withdraws a fact of each rule over a region of keys, a step of steps
 * (analysis/theory/query.ts movedOf), and two such rows are read as one union, the meeting part's negation of the
 * target outside it, which navigation read no further and left as written (Navigator.filteredOverSteps): edullm's
 * ledger, "Unfinal ended" over OutcomeAssertion, refused so.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRuleOverAQueryCompilesANegationAtATermAnInlinedDefinitionComputes = property.exhaust(
	finite(computedCase),
	{
		needs: {},
		situations: ["one rule", "two rules", "into", "out of", "check", "key"] satisfies ReadonlyArray<
			ReachedOf<ComputedReached>
		>,
		check: (_, k: Case<ComputedReached>) => (c) =>
			Effect.sync(() => {
				k.note(c.rules)
				k.note(c.rule)
				const compiled = compiledOf(computedSchemaOf(c))
				assert.deepEqual(
					compiled.ok ? undefined : compiled.error.reason,
					undefined,
					`the builders admit ${Formatter.format(c)}, and its compilation refuses it`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the builders' admission: a schema schema.extend builds compiles to its artifacts"
		},
		box: "every containment into and out of, check over and key over Unmarked, one rule or two, each matching a Titles row's title with its whitespace collapsed by an inlined query, and negating Names at it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					'\t\tsharing.kind === "perStatement" && interned.overSteps(read)\n\t\t\t? new Navigator(loc, columns, sharing, interned).filteredOverSteps(read, 0)\n\t\t\t: read\n',
				replacement: "\t\tread\n",
				why: "A rule over steps keeps its filters as written, as before: the meeting part over two rows of a region of keys negates the target, whose negation binds the collapsed title, and the checker refuses it; the two-rule containment into Unmarked fails."
			}
		]
	}
)
