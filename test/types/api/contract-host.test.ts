/**
 * A contract's values are its consumer's (test/types/api/contract-host.ts). Over every kind of base a contract is over,
 * its host type is the base's under its consumer's key; a fact's field and a program parameter's argument take that
 * type, the key's mint's, and refuse a plain base value and another contract's value over the same base; a read, the
 * relation's fact and a query's head, delivers it. Over every position a value stands at opposite a contract's term, a
 * typed constant and a conditional's other arm, where it becomes the contract's, take the key's mint's alone, and a
 * comparison and a match's binding take any value of the base. Over every position the database makes a value at, a
 * cast, a drawn field and an accumulated field, a consumer's contract takes its own key alone and every other target
 * none, and a clock bound to a contract's parameter and a declared function's result holding one are refused. Each is
 * a cell of its box; a batch's cells are one program, checked disarmed. Oracle: the rule of who makes a contract's
 * values, its key's holder by its mint.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import {
	contractHostBox,
	contractKeyBox,
	contractMintBox,
	contractValueBox
} from "#test/types/api/contract-host.dictionary.ts"
import {
	contractHostProgram,
	contractKeyProgram,
	contractMintProgram,
	contractValueProgram
} from "#test/types/api/contract-host.ts"
import { boxAgreement } from "#test/types/batch/agreement.ts"

/**
 * A write of a contract, a fact's field or a parameter's argument, takes its host type alone, its key's mint's, and a
 * read delivers it, over every kind of base.
 */
export const contractHost = boxAgreement(finite(word(contractHostBox)), {
	box: "every kind of base a contract is over: each pg type, numeric at scale 0 and at another, uuid, natural, date, a pattern of infinite language, of finite language and of a fixed prefix, a pattern held to its bytes, two patterns intersected, a closed id of an ordered roster, of an unordered one and of a subset, a span, a vector, another contract, and a contract that checks and proves",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: contractHostProgram,
	oracle: {
		kind: "specification",
		name: "a contract's values are its key's mint's: its host type is its base's under the key, which every write takes alone and every read delivers"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: '> extends Field<\n\tMarked<Infer<B>, K>,\n\tB["sql"],',
			replacement: '> extends Field<\n\tInfer<B>,\n\tB["sql"],',
			why: "A contract's host type is its base's, unmarked: a plain base value and another contract's value are written into its field and passed for its parameter, the directives are unused, and its host type is no longer the key's; the program fails at every cell."
		},
		{
			file: "packages/engine/src/types/fields/field.ts",
			original:
				"\tK extends symbol,\n\tProved extends ReadonlyArray<keyof Facts> = readonly []\n> extends Field<\n\tMarked<Infer<B>, K>,",
			replacement:
				"\tK extends symbol,\n\tProved extends ReadonlyArray<keyof Facts> = readonly []\n> extends Field<\n\tMarked<Infer<B>, symbol>,",
			why: "Every contract's host type is its base's under one key of every symbol, so two contracts over one base share their values: the other contract's value is written and passed where this one's belongs, its directives are unused, and the program fails."
		}
	]
})

/**
 * A value that becomes a contract's, a typed constant or a conditional's other arm, is its key's mint's alone, and a
 * value only compared with a contract's term is any value of its base.
 */
export const contractValue = boxAgreement(finite(word(contractValueBox)), {
	box: "every position a value stands at opposite a contract's term, a typed constant, a conditional's other arm, a comparison and a match's binding, by every kind of value, a plain bigint, the key's mint of one and another contract's value",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: contractValueProgram,
	oracle: {
		kind: "specification",
		name: "a value that becomes a contract's is its key's mint's; a value only compared is the base's"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original:
				"export type ValueLiteralOf<T> = [HostKeysOf<T>] extends [never]\n\t? LiteralOf<T>\n\t: Marked<LiteralOf<T>, Extract<HostKeysOf<T>, symbol>>",
			replacement: "export type ValueLiteralOf<T> = LiteralOf<T>",
			why: "A value that becomes a contract's is its base's literal, unmarked: a plain bigint and another contract's value become a typed constant and a conditional's arm of the contract, which no mint made, the directives are unused, and the program fails."
		},
		{
			file: "packages/engine/src/types/core/phantom.ts",
			original: "\tE extends HostMark<symbol> ? Unbranded<Unmarked<E>> : Unbranded<E>",
			replacement: "\tUnbranded<E>",
			why: "A contract's base keeps its host's marks, so a value only compared with a contract's term must be its key's mint's: a comparison and a match's binding of a plain bigint are refused where the rule admits them, and the program fails."
		}
	]
})

/**
 * A contract's key and a mint's are a unique symbol, its module's own: a value of type `symbol`, which any symbol is,
 * a registered one among them, is refused at both.
 */
export const contractKey = boxAgreement(finite(word(contractKeyBox)), {
	box: "every kind of key, a unique symbol and a value of type symbol, at a contract's first call and at mintOf",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: contractKeyProgram,
	oracle: {
		kind: "specification",
		name: "a key is its module's own unique symbol, the capability a mint needs"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/constructors.ts",
			original: "export type UniqueKey<K extends symbol> = symbol extends K",
			replacement: "export type UniqueKey<K extends symbol> = never extends K",
			why: "Every key is refused as no unique symbol, a module's own among them, so a contract and a mint over one are refused where the rule admits them; the program fails."
		},
		{
			file: "packages/engine/src/types/fields/constructors.ts",
			original:
				'\tbase: B &\n\t\tNoWriting &\n\t\tNotStoredOnly<B["sql"]> &\n\t\tNotExactBase<B["sql"]> &\n\t\tNotDigest<B["sql"]> &\n\t\tNotSearchDocument<B["sql"]> &\n\t\tNotInstantBase<B> &\n\t\tUniqueKey<K> &',
			replacement:
				'\tbase: B &\n\t\tNoWriting &\n\t\tNotStoredOnly<B["sql"]> &\n\t\tNotExactBase<B["sql"]> &\n\t\tNotDigest<B["sql"]> &\n\t\tNotSearchDocument<B["sql"]> &\n\t\tNotInstantBase<B> &',
			why: "A contract takes a key of type symbol, which any symbol is, a registered one among them, so its directive is unused; the program fails."
		}
	]
})

/**
 * The database makes a consumer's contract's values under its keys alone: a cast, a drawn field and an accumulated field
 * into one take its keys, its own then its base's, never another's or one of them alone, and into any other type none; a
 * clock bound to a contract's parameter takes its key by the parameter's name, and a declared function whose result
 * holds a contract takes each contract's key by its name; a contract over another is under a key of its own.
 */
export const contractMint = boxAgreement(finite(word(contractMintBox)), {
	box: "every position the database makes a contract's values at: a cast, a drawn field and an accumulated field, into a consumer's contract, a contract over another, natural and bigint, under its keys, none, another contract's, or one of a chain's alone; a clock of bigint, natural, a contract and a contract over another, under its key, none or another's; a declared function's result of its base, a contract and a contract over another, as a value, rows, one row and a variant's arm, under its keys, none, another's or one of a chain's alone; and a contract over another under a key of its own and under its base's",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: contractMintProgram,
	oracle: {
		kind: "specification",
		name: "a consumer's contract's values are made under its keys alone: on the host by its mints, in the database by a cast, a drawn field, an accumulated field, a clock and a declared function's result that take them"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: "\t\t\t: readonly []\n\t\t: MintKeys<F>",
			replacement: "\t\t\t: readonly []\n\t\t: ReadonlyArray<symbol>",
			why: "A mint into a consumer's contract takes any keys or none, so a cast, a drawn field and an accumulated field under no key, another contract's or one of a chain's alone are made, their directives unused; the program fails."
		},
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: "\t\t: readonly [key: OwnKeyOf<F>, ...MintKeys<B>]",
			replacement: "\t\t: readonly [key: OwnKeyOf<F>]",
			why: "A mint into a contract over another takes its own key alone, so the holder of Outer's key makes values that are Cents's too: the cells under Outer's key alone are made and those under both keys refused; the program fails."
		},
		{
			file: "packages/engine/src/types/compute/compute.ts",
			original: "\t\tto: T & Field<H, F, D> & NotInstant<D>,\n\t\t...key: MintKey<T>",
			replacement: "\t\tto: T & Field<H, F, D> & NotInstant<D>,\n\t\t...key: ReadonlyArray<symbol>",
			why: "A cast takes any keys or none whatever its target, so a cast into a consumer's contract under no key or another's is made and a key handed a cast into natural or bigint is taken; the cast cells' directives are unused, and the program fails."
		},
		{
			file: "packages/engine/src/types/db/workload.ts",
			original:
				"\t: readonly [keys: { readonly [N in KeyedOf<X, B>]: HostKeysOf<LanguageOf<X, N>> }]",
			replacement: "\t: readonly []",
			why: "A clock bound to a consumer's contract's parameter takes no key, so the clock makes the contract's values with none: the cell under no key is admitted and the one under its key refused; the program fails."
		},
		{
			file: "packages/engine/src/types/db/workload.ts",
			original: "\t\t? [ManyKeys<HostKeysOf<L>>] extends [true]\n\t\t\t? never\n\t\t\t: N",
			replacement: "\t\t? N",
			why: "A clock binds a contract over another's parameter under one key, so it makes Cents's values under Outer's key: its directive is unused; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/function.ts",
			original: "\t: readonly [mints: { readonly [P in OwnedIn<T> as P[0]]: P[1] }]",
			replacement: "\t: readonly []",
			why: "A declared function whose result holds a consumer's contract takes no mints, so its body makes the contract's values with no key: the result cells under no mints are admitted and those under the keys refused; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/function.ts",
			original: "\tT extends Rows<infer Fields>\n\t\t? OwnedInFields<Fields>",
			replacement: "\tT extends Rows<infer Fields>\n\t\t? never",
			why: "A declared function's rows of a consumer's contract take no mints, the contract nested in a heading unseen, so its body makes the contract's values with no key: the rows and one-row cells' directives are unused; the program fails."
		},
		{
			file: "packages/engine/src/types/fields/constructors.ts",
			original:
				'export type KeyApart<K extends symbol, B> = [K] extends [HostKeysOf<Infer<B>>]\n\t? Refusal<"a contract over another is under a key of its own, apart from its base\'s">\n\t: unknown',
			replacement: "export type KeyApart<K extends symbol, B> = unknown",
			why: "A contract over another is declared under its base's key, so its values are its base's on the host and one key mints both: the cell under the base's key is admitted, its directive unused; the program fails."
		}
	]
})
