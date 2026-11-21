import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import { ownedText, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { type SideDesc, type SlotsDesc, type TermDesc, termText } from "#compiler/ir/desc.ts"
import type { GeneratedLaw } from "#compiler/ir/law.ts"
import type {
	AboveLaw,
	DeclaredEntry,
	LawEntry,
	OwnLaw,
	RecordedLaw,
	StatedLaw
} from "#compiler/types/changeset/changeset.ts"

/**
 * What a statement's author states of the catalog entry (types/changeset LawEntry) of the laws it states: the entry,
 * `law({ name, source }, statement)`'s, or none, so each law's entry is derived. This module is where a law is named:
 * an author's entry rides beside what the law states (RecordedLaw), and every other law's is derived here, from what
 * the law states, wherever the law is read, lawsOf, a preview's refusal and a Db's refusal naming each by namedLaw, so
 * a recorded law and the law an application reads differ by a derived entry alone, which no artifact holds.
 */
export type StatedEntry = DeclaredEntry | { readonly kind: "derived" }

/** No entry declared: each law the statement states has its derived entry. */
export const derivedStatement: StatedEntry = Object.freeze({ kind: "derived" })

/**
 * The one entry of two statements that are one statement, or that state one law: the entry either declares, where one
 * does or both declare one alike; undefined where they declare two, which the schema refuses, since one law has one
 * name.
 */
export const mergedEntry = (a: StatedEntry, b: StatedEntry): StatedEntry | undefined => {
	if (a.kind === "derived") {
		return b
	}
	return b.kind === "derived" || (a.name === b.name && a.source === b.source) ? a : undefined
}

/** A name as a statement spells it: a JSON string. */
const quoted = (name: string): string => JSON.stringify(name)

/** The texts of a side's selection's conjuncts, each its canonical text, as the naming door's display spells them. */
const conjunctTexts = (side: SideDesc): ReadonlyArray<string> =>
	side.selection.conjuncts.map((c) => ownedText(c, withoutSourceLocs))

/** A side as a law's name spells it, as the naming door displays a side: R(t…), and `where` its conjuncts' texts. */
const sideName = (side: SideDesc): string => {
	const texts = conjunctTexts(side)
	return `${side.relation}(${side.terms.map(termText).join(", ")})${texts.length === 0 ? "" : ` where ${texts.join(" and ")}`}`
}

/** A term as on(...) takes it: a field's name, or pred of one. */
const termSource = (term: TermDesc): string =>
	term.kind === "field" ? quoted(term.field) : `pred(${quoted(term.field)})`

/** A side as a statement spells it: on(R, t…), its source select(R, …) where it selects. */
const sideSource = (side: SideDesc): string => {
	const texts = conjunctTexts(side)
	const source =
		texts.length === 0 ? side.relation : `select(${side.relation}, ${texts.join(" and ")})`
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

/**
 * A law no author entry names, as an application reads it: a pattern law's, a generated law's and a contract's, which no
 * statement states, and a recorded law whose statements' author declares none, each with its derived entry.
 */
export const derivedLaw = (law: StatedLaw): OwnLaw =>
	Object.freeze({ ...law, entry: derivedEntry(law) })

/** A generated field's law as an application reads it: no statement states it, so its entry is derived. */
export const namedGenerated = (
	law: GeneratedLaw
): Extract<OwnLaw, { readonly kind: "generated" }> =>
	Object.freeze({ ...law, entry: derivedEntry(law) })

/** A recorded law as an application reads it (types/changeset OwnLaw): its declared entry, or its derived one. */
export const namedLaw = (law: RecordedLaw): OwnLaw => ("entry" in law ? law : derivedLaw(law))

/** A recorded law of a level above as an outcome names it: the law with its entry. */
export const namedAbove = (above: AboveLaw<RecordedLaw>): AboveLaw =>
	Object.freeze({ kind: "above", level: above.level, law: namedLaw(above.law) })
