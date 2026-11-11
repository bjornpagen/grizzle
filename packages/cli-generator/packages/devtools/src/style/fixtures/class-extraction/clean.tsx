import { cva } from "class-variance-authority"

type Props = Readonly<{ className?: string; title: string; tone: "calm" }>

const tones = cva("flex", { variants: { tone: { calm: "p-2" } } })

const shared = { id: "panel", title: "x" } as const

function mergeSurfaceProps(
	baseProps: Readonly<{ className?: string }>,
	props: Readonly<{ className?: string }>
) {
	return { ...baseProps, ...props }
}

export function RestFixture({ className, tone, ...props }: Props) {
	return (
		<div className={className}>
			<span {...props} />
			<span {...shared} />
			<span {...{ id: "x", className: "flex" }} />
			<span className={tones({ tone, className })} />
		</div>
	)
}

export function BridgeFixture({
	baseProps,
	...props
}: Readonly<{ baseProps: Props; className?: string }>) {
	return <div {...mergeSurfaceProps(baseProps, props)} />
}
