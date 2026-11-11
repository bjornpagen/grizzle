declare module "clsx" {
	export type ClassValue =
		| string
		| false
		| null
		| undefined
		| Readonly<Record<string, boolean>>
		| ReadonlyArray<ClassValue>
	export function clsx(...inputs: ReadonlyArray<ClassValue>): string
}

declare module "tailwind-merge" {
	export function twMerge(...classLists: ReadonlyArray<string>): string
}

declare module "class-variance-authority" {
	export function cva(
		base: string,
		config: Readonly<Record<string, unknown>>
	): (props: Readonly<Record<string, unknown>>) => string
	export function cx(...inputs: ReadonlyArray<string>): string
}

declare module "next/font/local" {
	export default function localFont(
		options: Readonly<Record<string, unknown>>
	): Readonly<{ className: string; variable: string }>
}

declare namespace JSX {
	type Element = Readonly<Record<string, unknown>>
	interface IntrinsicElements {
		[name: string]: Readonly<Record<string, unknown>>
	}
}
