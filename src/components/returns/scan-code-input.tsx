"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";

/**
 * The P3 scan / type field (returns workspace lot + inspection screen).
 *
 * A USB scanner — or a fast operator — can type before React has hydrated
 * the page. The browser keeps that text in the field, but React 19 hydrates
 * the controlled input with its own state (""), so a handler reading state
 * silently ignored the next Enter and the action button stayed disabled
 * while the field visibly held a code. Hence:
 *   - Enter submits the field's own DOM value, never possibly-stale state;
 *   - on mount, text typed before hydration is adopted into the parent's
 *     state, so field, state and buttons agree.
 * An Enter pressed BEFORE hydration has no handler to reach; the text stays
 * and the next Enter submits it.
 * When the field is re-enabled (inspection: after the « revendable /
 * endommagé » choice) it takes the focus back, so the next scan lands here.
 */
export function ScanCodeInput({
  value,
  onValueChange,
  onSubmitCode,
  ...props
}: Omit<React.ComponentProps<"input">, "value" | "onChange" | "onKeyDown" | "ref"> & {
  value: string;
  onValueChange: (value: string) => void;
  onSubmitCode: (value: string) => void;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  const wasDisabled = React.useRef(Boolean(props.disabled));

  React.useEffect(() => {
    if (wasDisabled.current && !props.disabled) ref.current?.focus();
    wasDisabled.current = Boolean(props.disabled);
  }, [props.disabled]);

  React.useEffect(() => {
    const typedBeforeHydration = ref.current?.value ?? "";
    if (typedBeforeHydration && typedBeforeHydration !== value) onValueChange(typedBeforeHydration);
    // Mount only: adopting pre-hydration text once, never re-syncing afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Input
      {...props}
      ref={ref}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmitCode(e.currentTarget.value);
        }
      }}
    />
  );
}
