"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * A Link that stops its click from bubbling to an ancestor row (e.g.
 * ClickableTableRow's own onClick navigation). Needs to be a Client
 * Component itself — a Server Component can never pass an inline
 * event-handler prop like `onClick` across to `next/link`'s Link.
 */
export function StopPropagationLink(props: ComponentProps<typeof Link>) {
  return <Link {...props} onClick={(e) => e.stopPropagation()} />;
}
