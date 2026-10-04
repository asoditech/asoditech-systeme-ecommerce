/**
 * Opens the existing floating SupportWidget (src/components/support/support-widget.tsx)
 * from elsewhere in the app shell — e.g. the announcement bar's
 * « Contacter le support » (docs/adr/0059). A DOM event, not a second
 * support flow: the widget itself listens and simply opens its own panel.
 */
export const OPEN_SUPPORT_EVENT = "asoditech:open-support";

export function openSupportWidget(target: EventTarget | undefined = typeof window === "undefined" ? undefined : window): void {
  target?.dispatchEvent(new Event(OPEN_SUPPORT_EVENT));
}
