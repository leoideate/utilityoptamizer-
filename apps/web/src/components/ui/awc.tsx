"use client";

/**
 * AWC UI components used by the CRM's primitives. The React wrappers assign every prop they
 * receive to the element, so an `undefined` prop would overwrite the component's own default (an
 * undefined `value` crashes md-text-field). These versions drop undefined props first.
 */
import * as Awc from "@awc-ui/react";
import { type ComponentProps, type ComponentType, forwardRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any component type
function withoutUndefined<C extends ComponentType<any>>(Component: C): C {
  const Wrapped = forwardRef<unknown, ComponentProps<C>>(function AwcComponent(props, ref) {
    const clean = Object.fromEntries(Object.entries(props as object).filter(([, v]) => v !== undefined));
    const Inner = Component as unknown as ComponentType<Record<string, unknown>>;
    return <Inner {...clean} ref={ref} />;
  });
  Wrapped.displayName = `Awc(${Component.displayName ?? "Component"})`;
  return Wrapped as unknown as C;
}

export const MdButton = withoutUndefined(Awc.MdButton);
export const MdIconButton = withoutUndefined(Awc.MdIconButton);
export const MdTextField = withoutUndefined(Awc.MdTextField);
export const MdSelect = withoutUndefined(Awc.MdSelect);
export const MdSelectOption = withoutUndefined(Awc.MdSelectOption);
export const MdCheckbox = withoutUndefined(Awc.MdCheckbox);
export const MdSkeleton = withoutUndefined(Awc.MdSkeleton);
export const MdDialog = withoutUndefined(Awc.MdDialog);
export const MdMenu = withoutUndefined(Awc.MdMenu);
export const MdMenuItem = withoutUndefined(Awc.MdMenuItem);
export const MdMenuItemGroup = withoutUndefined(Awc.MdMenuItemGroup);
export const MdTabs = withoutUndefined(Awc.MdTabs);
export const MdTab = withoutUndefined(Awc.MdTab);
