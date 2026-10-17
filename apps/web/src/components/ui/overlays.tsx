"use client";

/**
 * Dialogs, menus and tabs, rendered with AWC UI (Material Design 3). They keep the props the
 * screens already use; the adapters map them onto md-dialog, md-menu and md-tabs.
 */
import { MdDialog, MdMenu, MdMenuItem, MdMenuItemGroup, MdTab, MdTabs } from "./awc";
import {
  Children,
  Fragment,
  type ReactElement,
  type ReactNode,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";
import { cn } from "@/lib/format";
import { textOf } from "./primitives";

// --- Dialog -----------------------------------------------------------------------------

/** A Material basic dialog: headline, optional description, body, and the footer as its actions. */
export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  // Mounted only while open, so closed dialogs aren't in the page (or the accessibility tree).
  if (!open) return null;
  return (
    <MdDialog
      open
      headline={title}
      className={cn("uo-dialog", wide && "uo-dialog-wide")}
      // Selects and menus inside the dialog fire their own (bubbling) mdClose: only the dialog's closes it.
      onMdClose={(e) => e.target === e.currentTarget && onOpenChange(false)}
    >
      {description && <p className="mb-3 text-sm text-muted">{description}</p>}
      <div className="text-text">{children}</div>
      {footer && (
        <div slot="actions" className="flex flex-wrap justify-end gap-2">
          {footer}
        </div>
      )}
    </MdDialog>
  );
}

// --- Menu -----------------------------------------------------------------------------------

interface MenuState {
  open: boolean;
  setOpen: (o: boolean) => void;
  anchorId: string;
}
const MenuContext = createContext<MenuState | null>(null);
const useMenu = () => {
  const m = useContext(MenuContext);
  if (!m) throw new Error("Menu parts must be inside <Menu>");
  return m;
};

export function Menu({ children, onOpenChange }: { children: ReactNode; onOpenChange?: (open: boolean) => void }) {
  const [open, setState] = useState(false);
  const anchorId = `menu-anchor-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const setOpen = useCallback(
    (o: boolean) => {
      setState(o);
      onOpenChange?.(o);
    },
    [onOpenChange],
  );
  const value = useMemo(() => ({ open, setOpen, anchorId }), [open, setOpen, anchorId]);
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
}

/** The element that opens the menu (always used as `asChild`: the child is the trigger). */
export function MenuTrigger({ children }: { children: ReactElement<{ id?: string; onClick?: (e: unknown) => void }>; asChild?: boolean }) {
  const { open, setOpen, anchorId } = useMenu();
  return cloneElement(children, {
    id: anchorId,
    onClick: (e: unknown) => {
      children.props.onClick?.(e);
      setOpen(!open);
    },
  });
}

/** Menu rows. Text becomes the Material headline; a leading icon (an element with no children) goes in the icon slot. */
export function MenuItem({ children, onSelect, disabled, danger, headline, supportingText }: { children?: ReactNode; onSelect?: () => void; disabled?: boolean; danger?: boolean; headline?: string; supportingText?: string }) {
  return <MenuItemRow onSelect={onSelect} disabled={disabled} danger={danger} headline={headline} supportingText={supportingText}>{children}</MenuItemRow>;
}
function MenuItemRow({ children, onSelect, disabled, danger, headline, supportingText, divider }: { children?: ReactNode; onSelect?: () => void; disabled?: boolean; danger?: boolean; headline?: string; supportingText?: string; divider?: boolean }) {
  const all = Children.toArray(children);
  const first = all[0];
  const icon = isValidElement<{ children?: ReactNode }>(first) && typeof first.type !== "string" && first.props.children === undefined && all.length > 1 ? first : null;
  const text = headline ?? textOf(icon ? all.slice(1) : all).trim();
  return (
    <MdMenuItem headline={text} supportingText={supportingText} disabled={disabled} divider={divider} onMdClick={() => onSelect?.()} style={danger ? { color: "var(--md-sys-color-error)" } : undefined}>
      {icon && (
        <span slot="leading-icon" className={cn("flex [&_svg]:size-5", danger && "text-danger")}>
          {icon}
        </span>
      )}
    </MdMenuItem>
  );
}

/** A section heading inside a menu. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
/** A divider between menu sections. */
export function MenuSeparator() {
  return null;
}

type Child = ReactElement<{ children?: ReactNode; divider?: boolean }>;
/** Flattens fragments and drops empty children, so sections can be read in order. */
function flatten(children: ReactNode): Child[] {
  return Children.toArray(children).flatMap((c) => (isValidElement<{ children?: ReactNode }>(c) && c.type === Fragment ? flatten(c.props.children) : isValidElement(c) ? [c as Child] : []));
}

/**
 * The menu surface. Labels start a labelled group, separators end a section (drawn as a divider
 * under its last row), and any other content is pinned above the items (the menu's header).
 */
export function MenuContent({ children, align = "end" }: { children: ReactNode; align?: "start" | "end" }) {
  const { open, setOpen, anchorId } = useMenu();
  const header: ReactNode[] = [];
  const sections: { label: string | null; items: Child[] }[] = [{ label: null, items: [] }];
  for (const c of flatten(children)) {
    const last = sections[sections.length - 1];
    if (c.type === MenuLabel) sections.push({ label: textOf(c.props.children).trim(), items: [] });
    else if (c.type === MenuSeparator) {
      if (last.items.length) last.items[last.items.length - 1] = cloneElement(last.items[last.items.length - 1], { divider: true });
      sections.push({ label: null, items: [] });
    } else if (c.type === MenuItem) last.items.push(cloneElement(c, {}) as Child);
    else header.push(c);
  }
  const row = (item: Child, key: string) => {
    const p = item.props as Parameters<typeof MenuItemRow>[0];
    return <MenuItemRow key={key} {...p} />;
  };
  return (
    <MdMenu anchor={anchorId} open={open} placement={align === "end" ? "bottom-end" : "bottom-start"} maxHeight="70vh" onMdClose={(e) => e.target === e.currentTarget && setOpen(false)}>
      {header.length > 0 && (
        <div slot="header" className="text-sm">
          {header}
        </div>
      )}
      {sections.map((s, i) =>
        s.label ? (
          <MdMenuItemGroup key={i} label={s.label}>
            {s.items.map((it, j) => row(it, `${i}-${j}`))}
          </MdMenuItemGroup>
        ) : (
          s.items.map((it, j) => row(it, `${i}-${j}`))
        ),
      )}
    </MdMenu>
  );
}

// --- Tabs -----------------------------------------------------------------------------------

const TabsContext = createContext<string>("");

/** Material primary tabs. Only the active panel is mounted, so other tabs don't load their data. */
export function Tabs({ value, onValueChange, tabs, children }: { value: string; onValueChange: (v: string) => void; tabs: { value: string; label: ReactNode }[]; children: ReactNode }) {
  const index = Math.max(0, tabs.findIndex((t) => t.value === value));
  return (
    <TabsContext.Provider value={value}>
      <MdTabs className="mb-4 block" activeTabIndex={index} tabWidth="auto" aria-label="Sections" onMdTabChange={(e) => tabs[e.detail.index] && onValueChange(tabs[e.detail.index].value)}>
        {tabs.map((t) => (
          <MdTab key={t.value} label={textOf(t.label)} />
        ))}
      </MdTabs>
      {children}
    </TabsContext.Provider>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  const active = useContext(TabsContext);
  if (active !== value) return null;
  return (
    <div role="tabpanel" aria-label={value} className="outline-none">
      {children}
    </div>
  );
}
