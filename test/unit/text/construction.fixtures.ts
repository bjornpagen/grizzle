/** What the properties of construction.test.ts read: their box of alternations of words, and their oracles. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { SearchSubsets, type Subset, subsetKey } from "@bjornpagen/grizzle-text/regex/subset"
import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, characterOf, type Gen, string, uniqueKeys } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, String as Str } from "effect"

/**
 * The characters a word is spelled in: a wide alphabet, as the names and namespaces of edullm's QTI schema's closed
 * pattern values are (KindByNameUnder: `^(?:http:\/\/ltsc\.ieee\.org\/xsd\/LOM\}(?:lom)|...)$`), so most atoms of a
 * pattern's alphabet lead each state to its restart closure. U+0001, the admitted domain's first code point, is none of
 * them, so the alphabet's first atom is one no word holds (restAtom).
 */
const wordCharacters: NonEmptyReadonlyArray<string> = Str.split(
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./:",
	""
)

/** A word of two to nine characters: never one, which an alternation would merge with its other one-character arms. */
const wordGen: Gen<string> = string(characterOf(wordCharacters), { min: 2, max: 9 })

/** A word in grizzle's pattern grammar, its `.` escaped. */
const spelled = (word: string): string => Str.replaceAll(".", "\\.")(word)

/**
 * An alternation of words, anchored at both ends: its words, flat (`^(?:w|w|...)$`), or under prefixes, as
 * KindByNameUnder's names are under their namespaces (`^(?:p(?:w|w)|q(?:w))$`), each group's words distinct.
 */
export interface Alternation {
	readonly groups: NonEmptyReadonlyArray<{
		readonly prefix: string
		readonly words: NonEmptyReadonlyArray<string>
	}>
}

/** The words an alternation's pattern holds, each prefix before each of its words, each once. */
export const wordsOf = (alternation: Alternation): ReadonlyArray<string> =>
	Arr.dedupe(Arr.flatMap(alternation.groups, (g) => Arr.map(g.words, (w) => `${g.prefix}${w}`)))

/** An alternation's pattern, in grizzle's pattern grammar under the flags "u". */
export const sourceOf = (alternation: Alternation): string => {
	const arms = (words: NonEmptyReadonlyArray<string>): string =>
		Arr.join(Arr.map(words, spelled), "|")
	const groups = Arr.map(alternation.groups, (g) =>
		g.prefix === "" ? arms(g.words) : `${spelled(g.prefix)}(?:${arms(g.words)})`
	)
	return `^(?:${Arr.join(groups, "|")})$`
}

/** One to sixteen distinct words, and at times the first of them extended by one to three characters. */
const wordsGen: Gen<NonEmptyReadonlyArray<string>> = (source) => {
	const [first, ...rest] = source.draw(uniqueKeys(wordGen, { min: 1, max: 16 }))
	const head = defined(first, "a drawn word")
	const extended = source.draw(boolean)
		? [`${head}${source.draw(string(characterOf(wordCharacters), { min: 1, max: 3 }))}`]
		: []
	return [head, ...Arr.dedupe([...rest, ...extended])]
}

/** The box: a flat alternation of words (wordsGen), or one to four groups of words under distinct prefixes. */
const alternationGen: Gen<Alternation> = (source) => {
	if (source.draw(boolean)) {
		return { groups: [{ prefix: "", words: source.draw(wordsGen) }] }
	}
	const [first, ...rest] = source.draw(uniqueKeys(wordGen, { min: 1, max: 4 }))
	const prefixes = [defined(first, "a drawn prefix"), ...rest]
	const [head, ...tail] = Arr.map(prefixes, (prefix) => ({ prefix, words: source.draw(wordsGen) }))
	return { groups: [defined(head, "a drawn group"), ...tail] }
}

/** Whether a word of the alternation is a prefix of another of its words. */
export const someWordExtendsAnother = (words: ReadonlyArray<string>): boolean =>
	Arr.some(words, (w) => Arr.some(words, (v) => v !== w && Str.startsWith(w)(v)))

/**
 * The states of the minimal DFA of a finite language, the dead state left out: one for each distinct right language
 * {s | p + s is a word} of a prefix p of a word (Myhill–Nerode).
 */
export const rightLanguages = (words: ReadonlyArray<string>): number => {
	const prefixes = Arr.dedupe(
		Arr.flatMap(words, (w) => Array.from({ length: w.length + 1 }, (_, i) => Str.slice(0, i)(w)))
	)
	/** A prefix's right language, its suffixes sorted and joined by a space, which no word holds. */
	const rightLanguage = (p: string): string =>
		Arr.join(
			Arr.sort(
				Arr.map(
					Arr.filter(words, (w) => Str.startsWith(p)(w)),
					(w) => Str.slice(p.length)(w)
				),
				Order.String
			),
			" "
		)
	return Arr.dedupe(Arr.map(prefixes, rightLanguage)).length
}

/** What the atom-by-atom construction made and spent, and the subset keys a construction of it needs at most. */
export interface AtomByAtom {
	readonly states: number
	readonly work: number
	readonly keys: number
}

/**
 * The subset construction of an alternation's NFA atom by atom, as dfa.ts determinize ran it at 0624a312c: every state it
 * reaches, in the order it reaches them, expanded on each atom in turn (SearchSubsets target), each step charged its
 * work, each target keyed and numbered where new. With the states it made and the work it was charged, it counts the
 * keys a construction needs at most: the initial subset's, and for each state one for its steps to its restart closure,
 * the target of the alphabet's first atom, which no word holds, and one for each atom it steps on to any other subset.
 */
export const atomByAtom = (nfa: Nfa): AtomByAtom => {
	const subsets = new SearchSubsets(nfa)
	const { atomCount, atomOf } = subsets.alphabet
	const restAtom = defined(atomOf[0], "the alphabet's first atom")
	const numbers = new Map<string, number>()
	const members: Array<Subset> = []
	const numbered = (subset: Subset): void => {
		const key = subsetKey(subset)
		if (!numbers.has(key)) {
			numbers.set(key, members.length)
			members.push(subset)
		}
	}
	numbered(subsets.initial.to)
	let work = subsets.initial.work
	let keys = 1
	for (let id = 0; id < members.length; id++) {
		const subset = defined(members[id], "a reached state")
		const restart = subsetKey(subsets.target(subset, restAtom).to)
		keys += 1
		for (let atom = 0; atom < atomCount; atom++) {
			const step = subsets.target(subset, atom)
			work += step.work
			if (subsetKey(step.to) !== restart) {
				keys += 1
			}
			numbered(step.to)
		}
	}
	return { states: members.length, work, keys }
}

/** One to three alternations a case reads, so a property's case reads more than one construction. */
export const alternationsGen: Gen<ReadonlyArray<Alternation>> = array(alternationGen, {
	min: 1,
	max: 3
})
