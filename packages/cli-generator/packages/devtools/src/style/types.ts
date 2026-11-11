import { Schema } from "effect"

/** Every rule the style linter reports, by the id it reports under: its name in the output and its fixture
 * directory. */
export const STYLE_RULES = [
	"class-extraction",
	"no-unresolved-class",
	"no-unverifiable-class",
	"no-dynamic-class",
	"no-invalid-color",
	"no-conflicting-classes",
	"no-arbitrary-value",
	"no-svg-paint",
	"stylesheet",
	"markup"
] as const

export type StyleRule = (typeof STYLE_RULES)[number]

/** One class as written: its text and where it starts, 1-based. */
export type ClassToken = Readonly<{ text: string; file: string; line: number; column: number }>

/** The classes of one static class string: one literal, or one literal type of a union. Conflicts and duplicates
 * are judged within one list; across lists, `cn` resolves them on purpose. */
export type ClassList = ReadonlyArray<ClassToken>

/** A Tailwind utility value or modifier: an arbitrary `[...]` value or a named theme value. */
const UtilityValue = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("arbitrary"), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("named"), value: Schema.String })
])

/** A variant as Tailwind parses it: `hover:`, `data-[size=sm]:`, `[&>svg]:`, or `group-hover:`, which wraps
 * another. Recursive, so its type is declared. */
export type Variant =
	| Readonly<{ kind: "static"; root: string }>
	| Readonly<{
			kind: "functional"
			root: string
			value: typeof UtilityValue.Type | null
			modifier: typeof UtilityValue.Type | null
	  }>
	| Readonly<{ kind: "arbitrary"; selector: string }>
	| Readonly<{
			kind: "compound"
			root: string
			modifier: typeof UtilityValue.Type | null
			variant: Variant
	  }>

const Variant: Schema.Codec<Variant> = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("static"), root: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("functional"),
		root: Schema.String,
		value: Schema.NullOr(UtilityValue),
		modifier: Schema.NullOr(UtilityValue)
	}),
	Schema.Struct({ kind: Schema.Literal("arbitrary"), selector: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("compound"),
		root: Schema.String,
		modifier: Schema.NullOr(UtilityValue),
		variant: Schema.suspend((): Schema.Codec<Variant> => Variant)
	})
])

/** The part of a parsed Tailwind candidate the style rules read; Tailwind's own types are not published. An
 * arbitrary candidate is an arbitrary property, `[padding:37px]`. */
export const Candidate = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("functional"),
		root: Schema.String,
		value: Schema.NullOr(UtilityValue),
		modifier: Schema.NullOr(UtilityValue),
		variants: Schema.Array(Variant),
		raw: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("static"),
		root: Schema.String,
		variants: Schema.Array(Variant),
		raw: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("arbitrary"),
		property: Schema.String,
		value: Schema.String,
		modifier: Schema.NullOr(UtilityValue),
		variants: Schema.Array(Variant),
		raw: Schema.String
	})
])

export type Candidate = typeof Candidate.Type

/** Tailwind's parse of one class: a candidate, or nothing Tailwind recognizes as one. */
export type ParsedClass = Candidate | Readonly<{ kind: "unparsed" }>

/** What a class compiles to: the variants it applies under, as written, and the CSS properties it declares on the
 * element, sorted and joined (what conflicts compare). */
export type CompiledClass = Readonly<{
	variants: string
	properties: string
}>

/** One class with what the design system says about it: Tailwind's parse, and its compiled CSS when it
 * compiles. */
export type ExplainedClass = ClassToken &
	Readonly<{
		candidate: ParsedClass
		compiled: CompiledClass | undefined
	}>

/** The named values a utility root takes from the theme: the namespaces they come from and their token names. */
export type Vocabulary = Readonly<{
	namespaces: ReadonlyArray<string>
	tokens: ReadonlyArray<string>
}>

/** The theme the stylesheet defines: its colors, the design tokens among them (the colors that reference a CSS
 * variable), every theme variable that is a design token (Tailwind's palette colors are not), and the vocabulary of
 * each root that takes named values; a root without one takes bare values only. */
export type Theme = Readonly<{
	colors: ReadonlySet<string>
	colorTokens: ReadonlySet<string>
	tokens: ReadonlySet<string>
	vocabularies: ReadonlyMap<string, Vocabulary>
}>

/** What a class rule reads: one class list, explained, and the theme. */
export type ClassRuleInput = Readonly<{
	list: ReadonlyArray<ExplainedClass>
	theme: Theme
}>

/** What a class rule says about one class of the list; the engine stamps the rule's id. */
export type ClassVerdict = Readonly<{ token: ClassToken; message: string; suggestion?: string }>

export type ClassRule = (input: ClassRuleInput) => ReadonlyArray<ClassVerdict>
