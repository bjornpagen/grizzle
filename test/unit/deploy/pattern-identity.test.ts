/**
 * Patterns by language: a Text.matches pattern is its pattern value, its language's key beside its spelling
 * (ir/pattern.ts PatternValue), and its spelling is no part of any identity (core/canonical.ts omitSourceLocs). So a
 * schema whose every match, guard, keyed selection, containment and derived relation reads a pattern installs the same
 * theory, every law under the same identifier with the same check identity, every relation's record and its schema's
 * fingerprint, and the same objects by kind and identifier, under any spelling of the pattern's language; a spelling of
 * another language identifies them otherwise. Each spelling's own SQL is what PostgreSQL reads: its ARE stands in what
 * the installation installs.
 *
 * The oracle is a specification: two installations are one by identity exactly when their patterns' language keys are
 * equal. The space: a pattern admitted over each family's alphabet (test/unit/text/generators.ts), written again in a
 * group, beside an empty piece, as an alternation of itself, or beside a code point no alphabet holds.
 *
 * An installation keeps one spelling of each language it installs (ir/pattern.ts installedSpellings), its history as a
 * roster's codes are, so a draft that only spells a pattern again in its language drafts nothing: no rename, no
 * rewrite, no VALIDATE, no index built and no rule checked again, its installation reading the ARE of the spelling the
 * installation holds; a spelling of another language is a change. A language its history does not spell takes the least
 * of the spellings the schema holds of it, by code unit, whatever order they are held in.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"
import { compareStrings } from "#compiler/core/order.ts"
import { installedSpellings } from "#compiler/ir/pattern.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import {
	fieldRenamedOver,
	heldSpellingsGen,
	identityOf,
	installedOf,
	installsAreOf,
	type Respelling,
	respelledOver,
	renameCases,
	respellings,
	spellingCases
} from "#test/unit/deploy/pattern-identity.fixtures.ts"

type Feature = Respelling | "one language, two spellings" | "two languages"

/** Two spellings of one pattern install one identity exactly when they spell one language. */
export const twoSpellingsOfAPatternInstallOneIdentityExactlyWhenTheySpellOneLanguage =
	property.explore(spellingCases, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			...respellings,
			"one language, two spellings",
			"two languages"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (s) =>
			Effect.sync(() => {
				c.note(s.respelling)
				const first = installedOf(s.first)
				const second = installedOf(s.second)
				const oneLanguage = s.first.pattern === s.second.pattern
				c.note(oneLanguage ? "one language, two spellings" : "two languages")
				if (oneLanguage) {
					assert.deepEqual(
						identityOf(second.snapshot),
						identityOf(first.snapshot),
						`/${s.second.spelling}/ installs what /${s.first.spelling}/ does, one language`
					)
				} else {
					assert.notDeepEqual(
						identityOf(second.snapshot).theory.laws,
						identityOf(first.snapshot).theory.laws,
						`/${s.second.spelling}/ identifies its laws otherwise than /${s.first.spelling}/`
					)
				}
				assert.ok(
					installsAreOf(second.installation, s.second),
					`the installation reads the ARE of its own spelling, /${s.second.spelling}/`
				)
				const respelled = respelledOver(first, s.second, s.first)
				assert.equal(
					respelled.change,
					oneLanguage ? "none" : "schema",
					`a draft of /${s.second.spelling}/ over /${s.first.spelling}/'s snapshot drafts ${oneLanguage ? "nothing" : "a change"}`
				)
				if (oneLanguage) {
					assert.ok(
						respelled.installsFirst,
						`the draft reads the ARE of the spelling its installation holds, /${s.first.spelling}/`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "two installations one by identity exactly when their patterns' language keys are equal"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/deploy/pattern-identity.test.ts#twoSpellingsOfAPatternInstallOneIdentityExactlyWhenTheySpellOneLanguage:-:0.1.0.0.0.3"
				),
				reason:
					"// and (?:)|\u{2603}, one language, whose session deltas' readers were named by their selections' SQL text, each spelling's ARE in it",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original:
					"\t\t\t...new Map(selection.map((e) => [printExpr(named.expr(e)), e] as const)).entries()\n",
				replacement:
					"\t\t\t...new Map(selection.map((e) => [printExpr(e), e] as const)).entries()\n",
				why: "A session delta's reader is named by its selection's SQL text, each pattern by its spelling's ARE: two spellings of one language name two readers, and the identities differ."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original:
					'\t\t(value["kind"] === "every" || value["kind"] === "refined")) ||\n\t(key === "spelling" && typeof value === "string")',
				replacement: '\t\t(value["kind"] === "every" || value["kind"] === "refined"))',
				why: "Identity by text: a pattern's spelling is part of every identity, so two spellings of one language are two laws, two checks and two derived relations, and every law over the pattern is identified anew."
			},
			{
				file: "packages/engine/src/ir/pattern.ts",
				original: "[pattern, history.get(pattern) ?? spelled] as const",
				replacement: "[pattern, spelled] as const",
				why: "The spellings table not read: a draft installs each language by the schema's spelling, so a re-spelling in one language moves every CHECK, generated column and index predicate that reads it, a rewrite, a VALIDATE and an index build where nothing changed."
			}
		]
	})

/** Whether a statement does work over stored rows or an index: a table, column or constraint added, dropped,
 * re-expressed or validated, an index built or dropped, a stored derived relation's table created or filled. */
const worksOverRows = (st: SqlStatement): boolean =>
	st.kind === "createTable" ||
	st.kind === "createIndex" ||
	st.kind === "dropIndex" ||
	st.kind === "createStoredTable" ||
	st.kind === "fillStored" ||
	(st.kind === "alterTable" &&
		Arr.some(
			st.actions,
			(a) =>
				a.kind !== "enableRowSecurity" &&
				a.kind !== "disableRowSecurity" &&
				a.kind !== "replicaIdentity" &&
				a.kind !== "alterConstraintDeferral"
		))

/**
 * A declared rename of the field a keyed selection and a containment read renames each law column over it, whose
 * statement names the field and whose definition reads its column (deploy/diff/declared.ts lawColumnRenames): the draft
 * renames the field's column and each law column, comments them, and drops, adds, validates, builds and checks nothing
 * again. The oracle is a specification: every statement a rename or a comment, and no step over stored rows.
 */
export const aDeclaredFieldRenameRenamesTheLawColumnsOverItByTheirDefinitions = property.explore(
	renameCases,
	{
		needs: {},
		budget: { runs: 16, steered: 16 },
		situations: ["renamed"] satisfies ReadonlyArray<Reached<"renamed">>,
		check: (_, c: Case<"renamed">) => (r) =>
			Effect.sync(() => {
				const drafted = fieldRenamedOver(installedOf(r.pattern), r.pattern, r.to)
				assert.deepEqual(
					Arr.filter(drafted.statements, worksOverRows),
					[],
					`a rename of u to ${r.to} adds, drops, re-expresses, validates and builds nothing`
				)
				assert.deepEqual(drafted.rowSteps, [], `a rename of u to ${r.to} reads no stored row`)
				const kinds = new Set(Arr.map(drafted.statements, (st) => st.kind))
				if (kinds.has("renameColumn")) {
					c.note("renamed")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a declared rename renames what it names and what is named by it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original:
					'\t\t\t\t\t\tcanonicalEquals({ ...readThrough(d), name: "" }, { ...definition, name: "" })',
				replacement: "\t\t\t\t\t\tfalse",
				why: "A generated law column is not found by its definition, so one a declared rename names otherwise is dropped and drawn again, a rewrite of its table, where it is renamed."
			}
		]
	}
)

type SpellingFeature =
	| "a language of four spellings"
	| "two languages"
	| "a language its history spells"
	| "spellings held in another order"

/**
 * An installation spells each language it installs by its history, else by the least of the spellings it holds, by code
 * unit, whatever order they are held in (ir/pattern.ts installedSpellings): over one or two drawn languages, each a
 * pattern and three respellings of its own language, held in two drawn orders, the two tables are one, each language
 * the held spellings spell, by its key, spelled by its history's spelling or the least of all its spellings, two drawn
 * languages that are one language (`$` and the empty pattern) among them, and each held spelling installs as its
 * language's. The order a schema holds its
 * patterns in is its owned statements' order, which no meaning fixes, so a first spelling met moved with it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anInstallationSpellsEachLanguageByItsHistoryElseItsLeastSpellingWhateverOrderItsSpellingsAreHeldIn =
	property.explore(heldSpellingsGen, {
		needs: {},
		situations: [
			"a language of four spellings",
			"two languages",
			"a language its history spells",
			"spellings held in another order"
		] satisfies ReadonlyArray<Reached<SpellingFeature>>,
		check: (_, k: Case<SpellingFeature>) => (drawn) =>
			Effect.sync(() => {
				const installed = installedSpellings(drawn.history, drawn.held)
				const reordered = installedSpellings(drawn.history, drawn.reordered)
				const byLanguage = Order.mapInput(
					Order.String,
					([language]: readonly [string, string]) => language
				)
				assert.deepEqual(
					Arr.sort([...reordered.table], byLanguage),
					Arr.sort([...installed.table], byLanguage),
					"the spellings are one whatever order they are held in"
				)
				/** Each language the held spellings spell, by its key: two drawn languages may be one, as `$` and the
				 * empty pattern are, each spelling the empty text's language alone, so a language is its key's spellings. */
				const languages = Arr.groupBy(drawn.held, (p) => p.pattern)
				for (const [pattern, spellings] of Rec.toEntries(languages)) {
					const [one] = spellings
					const least = Arr.reduce(spellings, one.spelling, (min, p) =>
						compareStrings(p.spelling, min) < 0 ? p.spelling : min
					)
					const spelled = drawn.history.get(pattern) ?? least
					assert.equal(
						installed.table.get(pattern),
						spelled,
						`a language is spelled by its history, else by its least spelling, of ${spellings.length}`
					)
					for (const p of spellings) {
						assert.equal(
							installed.of(p.spelling),
							spelled,
							`${p.spelling} installs as its language's`
						)
					}
					if (drawn.history.has(pattern)) {
						k.note("a language its history spells")
					}
				}
				k.note("a language of four spellings")
				if (Rec.keys(languages).length > 1) {
					k.note("two languages")
				}
				if (Arr.some(drawn.held, (p, i) => drawn.reordered[i] !== p)) {
					k.note("spellings held in another order")
				}
			}),
		oracle: {
			kind: "specification",
			name: "each language's spelling its history's, else the least of its held spellings by code unit, in every order"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/pattern.ts",
				original: "compareStrings(p.spelling, spelled) < 0 ? p.spelling : spelled",
				replacement: "spelled",
				why: "Each language spelled by the first of its spellings met, so two orders of one schema's patterns install two spellings of a language: the order its statements stand in spells it."
			}
		]
	})
