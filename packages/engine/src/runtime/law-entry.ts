import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import { type SideDesc, type SlotsDesc, type TermDesc, termText } from "#compiler/ir/desc.ts"
import type { GeneratedLaw } from "#compiler/ir/law.ts"
import { predicateSource, spelledPattern } from "#compiler/scalar/compute/predicate-source.ts"
import { spelling } from "#compiler/scalar/compute/spelling.ts"
import type {
	AboveLaw,
	DeclaredEntry,
	LawEntry,
	OwnLaw,
	RecordedLaw,
	StatedEntry,
	StatedLaw
} from "#compiler/types/changeset/changeset.ts"

/**
 * Where a law is named: an author's entry rides beside what the law states (RecordedLaw), and every other law's entry
 * is derived here, from what the law states, wherever the law is read, lawsOf, a preview's refusal and a Db's refusal
 * naming each by namedLaw, so a recorded law and the law an application reads differ by a derived entry alone, which no
 * artifact holds. What a schema's authors declare of the entries (DeclaredEntries, mergedDeclared) is the schema's
 * (schema/law-entries.ts), which the schema builders read and the runtime reads none of.
 */

/** A name as a statement spells it: a JSON string. */
const quoted = (name: string): string => JSON.stringify(name)

/** A side's selection's conjuncts as the law's name reads them: each its author's predicate over the bare fields. */
const conjunctNames = (side: SideDesc): ReadonlyArray<string> =>
	side.selection.conjuncts.map((c) => predicateSource(c, (f) => f, spelledPattern))

/** A side's selection as select(R, …) takes it: one predicate of the row `r`, its conjuncts' Logic.and of several. */
const selectionSource = (side: SideDesc): string => {
	const conjuncts = side.selection.conjuncts.map((c) =>
		predicateSource(c, (f) => `r.${f}`, spelledPattern)
	)
	return `(r) => ${conjuncts.length === 1 ? conjuncts.join("") : `${spelling.and}(${conjuncts.join(", ")})`}`
}

/** A side as a law's name spells it: R(t…), and `where` each conjunct of its selection as its author writes it. */
const sideName = (side: SideDesc): string => {
	const texts = conjunctNames(side)
	return `${side.relation}(${side.terms.map(termText).join(", ")})${texts.length === 0 ? "" : ` where ${texts.join(" and ")}`}`
}

/** A term as on(...) takes it: a field's name, or pred of one. */
const termSource = (term: TermDesc): string =>
	term.kind === "field" ? quoted(term.field) : `pred(${quoted(term.field)})`

/** A side as a statement spells it: on(R, t…), its source select(R, …) where it selects. */
const sideSource = (side: SideDesc): string => {
	const source =
		side.selection.conjuncts.length === 0
			? side.relation
			: `select(${side.relation}, ${selectionSource(side)})`
	return `on(${[source, ...side.terms.map(termSource)].join(", ")})`
}

/** A family's slots as a statement spells them: fin(O, n). */
const slotsSource = (slots: SlotsDesc): string => `fin(${slots.owner}, ${quoted(slots.count)})`

/** Fields as a statement lists them. */
const fieldList = (fields: ReadonlyArray<string>): string => `[${fields.map(quoted).join(", ")}]`

/** A derived entry. */
const derived = (name: string, source: string): LawEntry =>
	Object.freeze({ kind: "derived", name, source })

/**
 * The entry grizzle derives for a law whose schema's author declares none (LawEntry `derived`), from what it states: its
 * name as the naming door displays the law, but a check's and a contract's, which are their declared names, and its
 * source the statement that states it, as grizzle spells it. A primary key is its relation's, a pattern law its field's
 * text refinement and a generated law its generated field's, which no statement states.
 */
export const derivedEntry = (law: StatedLaw): LawEntry => {
	switch (law.kind) {
		case "primaryKey":
			return derived(
				`primary key ${law.relation}(${law.fields.join(", ")})`,
				`relation(${quoted(law.relation)}, …, ${fieldList(law.fields)})`
			)
		case "key":
			return derived(`key ${sideName(law.side)}`, `key(${sideSource(law.side)})`)
		case "check":
			return derived(law.name, `check(${quoted(law.name)}, ${law.relation}, …)`)
		case "contained":
			return derived(
				`${sideName(law.from)} in ${sideName(law.to)}`,
				`contained(${sideSource(law.from)}, ${sideSource(law.to)})`
			)
		case "coverage":
			return derived(
				`${sideName(law.from)} covered by ${sideName(law.to)}`,
				`contained(${sideSource(law.from)}, ${sideSource(law.to)})`
			)
		case "family":
			return derived(
				`${law.order} ${sideName(law.member)} in ${slotsSource(law.slots)}`,
				`${law.order}(${sideSource(law.member)}, ${slotsSource(law.slots)})`
			)
		case "tree":
			return derived(
				`tree ${law.member.relation}(${[...law.root, ...law.member.terms.map(termText)].join(", ")}) in ${slotsSource(law.slots)}`,
				`tree(${sideSource(law.member)}, ${slotsSource(law.slots)}, { root: ${fieldList(law.root)} })`
			)
		case "fold":
			return derived(
				`${law.monoid} fold over ${slotsSource(law.family)} of ${sideName(law.step)} into ${sideName(law.end)}`,
				`fold(${slotsSource(law.family)}, Monoid.${law.monoid}, ${sideSource(law.step)}, ${sideSource(law.end)})`
			)
		case "contract":
			return derived(law.contract, `contract(${quoted(law.contract)}, …)`)
		case "pattern":
			return derived(
				`pattern of ${law.relation}.${law.field}`,
				`${law.relation}.${law.field}: ${patternsSource(law.patterns)}`
			)
		case "generated":
			return derived(
				`generated ${law.relation}.${law.field}`,
				`relation.generated(${quoted(law.relation)}, …) field ${quoted(law.field)}`
			)
		case "sealed":
			return derived(`sealed ${law.unit}`, `sealed(unit(${quoted(law.unit)}, …))`)
	}
}

/** A field's patterns as its type declares them: str.regex of one, str.and of several, each a regular expression. */
const patternsSource = (patterns: Patterns): string => {
	const spelled = patterns.map((p) => `/${p.source}/${p.flags}`)
	return spelled.length === 1 ? `str.regex(${spelled.join("")})` : `str.and(${spelled.join(", ")})`
}

/**
 * A law as grizzle's artifacts record it (types/changeset RecordedLaw): what it states, with `entry` beside it where its
 * statements' author declares one, and nothing beside it otherwise, so a schema whose author declares no entry records
 * its laws as they state themselves and its artifacts are what they were before entries existed.
 */
export const recordedLaw = (law: StatedLaw, entry: StatedEntry): RecordedLaw =>
	entry.kind === "declared" ? Object.freeze({ ...law, entry }) : law

/** A law with the entry grizzle derives for it, as an application reads a law no author's entry names. */
export const derivedLaw = (law: StatedLaw): OwnLaw =>
	Object.freeze({ ...law, entry: derivedEntry(law) })

/**
 * A generated field's law as its artifacts record it: its entry beside it where the field's author declares one
 * (DeclaredEntries `generated`), and nothing beside it otherwise.
 */
export type RecordedGenerated = GeneratedLaw | (GeneratedLaw & { readonly entry: DeclaredEntry })

/** A generated field's law, recorded with the entry `entry` its field's author declares, or none (RecordedGenerated). */
export const recordedGenerated = (
	law: GeneratedLaw,
	entry: DeclaredEntry | undefined
): RecordedGenerated => (entry === undefined ? law : Object.freeze({ ...law, entry }))

/** A generated field's law as an application reads it: its declared entry, or its derived one. */
export const namedGenerated = (
	law: RecordedGenerated
): Extract<OwnLaw, { readonly kind: "generated" }> =>
	"entry" in law ? law : Object.freeze({ ...law, entry: derivedEntry(law) })

/** A recorded law as an application reads it (types/changeset OwnLaw): its declared entry, or its derived one. */
export const namedLaw = (law: RecordedLaw): OwnLaw => ("entry" in law ? law : derivedLaw(law))

/** A recorded law of a level above as an outcome names it: the law with its entry. */
export const namedAbove = (above: AboveLaw<RecordedLaw>): AboveLaw =>
	Object.freeze({ kind: "above", level: above.level, law: namedLaw(above.law) })
