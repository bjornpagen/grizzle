import { cva } from "class-variance-authority"

type Props = Readonly<{ className?: string; title: string }>

declare const external: Props
declare const loose: unknown
declare const bag: Readonly<Record<string, string>>

const shared = { id: "panel" } as const

function mergeSurfaceProps(
	baseProps: Readonly<{ className?: string }>,
	props: Readonly<{ className?: string }>
) {
	return { ...baseProps, ...props }
}

function mergeOtherProps(
	baseProps: Readonly<{ className?: string }>,
	props: Readonly<{ className?: string }>
) {
	return { ...baseProps, ...props }
}

const tones = cva("flex", {
	variants: {
		tone: {
			get calm() { // violation
				return "p-2"
			}
		}
	}
})

export function SpreadFixture(props: Props) {
	return (
		<section>
			<div
				{...external} // violation
			/>
			<div
				{...bag} // violation
			/>
			<div
				{...loose} // violation
			/>
			<div
				{...props} // violation
			/>
			<div {...{ className: "flex", ...external }} /> {/* // violation */}
			<div {...shared} />
			<p
				className={tones(external)} // violation
			/>
		</section>
	)
}

export function BridgeFixture({
	baseProps,
	...props
}: Readonly<{ baseProps: Props; className?: string }>) {
	return (
		<section>
			<div
				{...mergeSurfaceProps(props, baseProps)} // violation
			/>
			<div
				{...mergeSurfaceProps(external, props)} // violation
			/>
			<div
				{...mergeOtherProps(baseProps, props)} // violation
			/>
		</section>
	)
}

export function RenamedBridgeFixture({
	baseProps: base,
	...props
}: Readonly<{ baseProps: Props; className?: string }>) {
	return (
		<div
			{...mergeSurfaceProps(base, props)} // violation
		/>
	)
}

export function splitBridge(
	{ baseProps }: Readonly<{ baseProps: Props }>,
	{ ...props }: Readonly<{ className?: string }>
) {
	return (
		<div
			{...mergeSurfaceProps(baseProps, props)} // violation
		/>
	)
}
