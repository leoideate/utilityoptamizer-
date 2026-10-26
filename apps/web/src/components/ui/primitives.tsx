"use client";

/**
 * The CRM's UI primitives, rendered with AWC UI (Material Design 3 web components). Screens keep
 * using these names and props; the adapters translate them: AWC controls report edits with their
 * own events (mdInput, mdChange), which are passed on as onChange with `event.target` being the
 * element, whose `value` / `checked` hold the new state, so react-hook-form and controlled state
 * both keep working.
 */
import { MdButton, MdCheckbox, MdIconButton, MdSelect, MdSelectOption, MdSkeleton, MdTextField } from "./awc";
import { Slot } from "@radix-ui/react-slot";
import {
  Children,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type CSSProperties,
  type ForwardedRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "@/lib/format";

/** Plain text of React children (for props such as a menu item's headline). */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Splits children into a leading icon (an element with no children, e.g. a lucide icon) and the rest. */
function splitIcon(children: ReactNode): { icon: ReactNode; rest: ReactNode[] } {
  const all = Children.toArray(children);
  const first = all[0];
  if (isValidElement<{ children?: ReactNode }>(first) && typeof first.type !== "string" && first.props.children === undefined && all.length > 1) {
    return { icon: first, rest: all.slice(1) };
  }
  return { icon: null, rest: all };
}

// --- Button -----------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "sm" | "md" | "lg" | "icon";

const MD_VARIANT: Record<Variant, "filled" | "outlined" | "text"> = { primary: "filled", secondary: "outlined", ghost: "text", danger: "filled", accent: "filled" };
const MD_SIZE = { sm: "xs", md: "sm", lg: "md", icon: "sm" } as const;
const VARIANT_STYLE: Partial<Record<Variant, CSSProperties>> = {
  danger: { "--md-button-container-color": "var(--md-sys-color-error)", "--md-button-label-color": "var(--md-sys-color-on-error)" } as CSSProperties,
  accent: { "--md-button-container-color": "var(--accent)", "--md-button-label-color": "#2b1d00" } as CSSProperties,
};

/** Classes for links rendered as buttons (asChild), matching the Material button shapes. */
const linkButton: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  secondary: "border border-[var(--md-sys-color-outline)] text-primary hover:bg-primary/8",
  ghost: "text-primary hover:bg-primary/8",
  danger: "bg-danger text-[var(--md-sys-color-on-error)] hover:opacity-90",
  accent: "bg-accent text-[#2b1d00] hover:opacity-90",
};
const linkSize: Record<Size, string> = { sm: "h-8 px-3 text-sm", md: "h-10 px-5 text-sm", lg: "h-12 px-6 text-base", icon: "size-10" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant | null;
  size?: Size | null;
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button({ className, variant, size, asChild, loading, children, disabled, type, style, onClick, ...props }, ref) {
  const v = variant ?? "primary";
  const s = size ?? "md";
  if (asChild) {
    // Links keep client-side navigation, so they stay anchors styled as Material buttons.
    return (
      <Slot
        ref={ref as ForwardedRef<HTMLElement>}
        className={cn("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium tracking-[0.1px] transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0", linkButton[v], linkSize[s], className)}
        {...props}
      >
        {children}
      </Slot>
    );
  }
  const common = { className: cn("shrink-0", className), style: { ...VARIANT_STYLE[v], ...style }, disabled: disabled || undefined, onClick: onClick as never, title: props.title, id: props.id, "aria-label": props["aria-label"], "aria-busy": loading || undefined, "aria-expanded": props["aria-expanded"], "aria-haspopup": props["aria-haspopup"], "aria-controls": props["aria-controls"], "aria-pressed": props["aria-pressed"] };
  if (s === "icon") {
    return (
      <MdIconButton ref={ref as ForwardedRef<HTMLMdIconButtonElement>} {...common} variant={v === "primary" ? "filled" : v === "secondary" ? "outlined" : "standard"} aria-label={props["aria-label"] ?? (textOf(children) || undefined)}>
        <span className="flex [&_svg]:size-5">{children}</span>
      </MdIconButton>
    );
  }
  const { icon, rest } = splitIcon(children);
  return (
    <MdButton ref={ref as ForwardedRef<HTMLMdButtonElement>} {...common} variant={MD_VARIANT[v]} size={MD_SIZE[s]} type={type === "submit" || type === "reset" ? type : "button"} loading={loading || undefined}>
      {icon && (
        <span slot="leading-icon" className="flex [&_svg]:size-[18px]">
          {icon}
        </span>
      )}
      {rest}
    </MdButton>
  );
});

// --- Form controls -------------------------------------------------------------------

/** Field context handed to Material controls by <Field>: they render the label, hint and error themselves. */
interface FieldBits {
  fieldLabel?: string;
  fieldHint?: string;
  fieldError?: string;
  fieldRequired?: boolean;
}

/** Passes an AWC custom event on as a change event: `target` is the element, holding the new value. */
const asChange = <T,>(e: Event) => e as unknown as ChangeEvent<T>;

/** Native-only input types the Material text field doesn't replace. */
const NATIVE_INPUTS = new Set(["file", "range", "checkbox", "radio", "hidden", "color"]);

const nativeControl = "w-full rounded-[var(--md-sys-shape-corner-extra-small)] border border-[var(--md-sys-color-outline)] bg-surface px-3 text-sm text-text placeholder:text-muted/70 disabled:opacity-60 aria-[invalid=true]:border-danger";

type InputProps = InputHTMLAttributes<HTMLInputElement> & FieldBits;

/**
 * A Material text field. `className` sizes the box (h-8 in tables becomes the densest rung).
 * Pass `aria-label` when there's no visible label.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const { className, fieldLabel: _l, fieldHint: _h, fieldError: _e, fieldRequired: _r, type, ...p } = props;
  if (type && NATIVE_INPUTS.has(type)) return <input ref={ref} type={type} className={cn(nativeControl, "h-10", className)} {...p} />;
  return <MaterialInput ref={ref} {...props} />;
});

/** Date and time inputs always show their format, so the label floats above it. */
const DATE_TYPES = new Set(["date", "datetime-local", "time", "month", "week"]);

const MaterialInput = forwardRef<HTMLInputElement, InputProps>(function MaterialInput(props, ref) {
  const { className, fieldLabel, fieldHint, fieldError, fieldRequired, type, onChange, value, defaultValue, autoFocus, ...p } = props;
  const host = useRef<HTMLMdTextFieldElement>(null);
  useImperativeHandle(ref, () => host.current as unknown as HTMLInputElement, []);
  useLayoutEffect(() => {
    if (autoFocus) void host.current?.setFocus?.();
  }, [autoFocus]);
  const compact = /\bh-(7|8|9)\b/.test(className ?? "");
  return (
    <MdTextField
      ref={host}
      className={cn("min-w-0", className?.replace(/\bh-\d+\b/g, ""))}
      variant="outlined"
      density={compact ? -4 : -2}
      type={type ?? "text"}
      label={fieldLabel}
      supportingText={fieldError ? undefined : fieldHint}
      error={!!fieldError || p["aria-invalid"] === true || p["aria-invalid"] === "true"}
      errorText={fieldError}
      required={fieldRequired || p.required}
      value={value === undefined || value === null ? (defaultValue === undefined ? undefined : String(defaultValue)) : String(value)}
      name={p.name}
      placeholder={p.placeholder ?? (type && DATE_TYPES.has(type) ? " " : undefined)}
      disabled={p.disabled}
      readOnly={p.readOnly}
      min={p.min === undefined ? undefined : String(p.min)}
      max={p.max === undefined ? undefined : String(p.max)}
      step={p.step === undefined ? undefined : String(p.step)}
      maxLength={p.maxLength}
      minLength={p.minLength}
      pattern={p.pattern}
      autocomplete={p.autoComplete}
      inputMode={p.inputMode}
      aria-label={fieldLabel ? undefined : p["aria-label"]}
      id={p.id}
      onBlur={p.onBlur as never}
      onKeyDown={p.onKeyDown as never}
      onMdInput={(e) => onChange?.(asChange<HTMLInputElement>(e as unknown as Event))}
    />
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldBits;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(props, ref) {
  const { className, fieldLabel, fieldHint, fieldError, fieldRequired, onChange, value, defaultValue, rows, ...p } = props;
  return (
    <MdTextField
      ref={ref as unknown as ForwardedRef<HTMLMdTextFieldElement>}
      className={cn("min-w-0", className)}
      variant="outlined"
      density={-2}
      multiline="fixed"
      rows={rows ?? 3}
      label={fieldLabel}
      supportingText={fieldError ? undefined : fieldHint}
      error={!!fieldError}
      errorText={fieldError}
      required={fieldRequired || p.required}
      value={value === undefined || value === null ? (defaultValue === undefined ? undefined : String(defaultValue)) : String(value)}
      name={p.name}
      placeholder={p.placeholder}
      disabled={p.disabled}
      maxLength={p.maxLength}
      aria-label={fieldLabel ? undefined : p["aria-label"]}
      id={p.id}
      onBlur={p.onBlur as never}
      onKeyDown={p.onKeyDown as never}
      onMdInput={(e) => onChange?.(asChange<HTMLTextAreaElement>(e as unknown as Event))}
    />
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & FieldBits;

/** A Material select built from ordinary <option> children. Option groups fall back to a native select. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, ref) {
  const { className, children, fieldLabel, fieldHint, fieldError, fieldRequired, onChange, value, defaultValue, ...p } = props;
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; label?: string }>[];
  if (items.some((o) => o.type === "optgroup")) {
    return (
      <select ref={ref} className={cn(nativeControl, "h-10 pr-8", className)} onChange={onChange} value={value} defaultValue={defaultValue} aria-label={fieldLabel ?? p["aria-label"]} {...p}>
        {children}
      </select>
    );
  }
  return (
    <MdSelect
      ref={ref as unknown as ForwardedRef<HTMLMdSelectElement>}
      className={cn("min-w-0", className?.replace(/\bh-\d+\b/g, ""))}
      variant="outlined"
      density={/\bh-(7|8|9)\b/.test(className ?? "") ? -4 : -2}
      label={fieldLabel}
      supportingText={fieldError ? undefined : fieldHint}
      error={!!fieldError}
      errorText={fieldError}
      required={fieldRequired || p.required}
      value={value === undefined || value === null ? (defaultValue === undefined ? undefined : String(defaultValue)) : String(value)}
      name={p.name}
      disabled={p.disabled}
      aria-label={fieldLabel ? undefined : p["aria-label"]}
      id={p.id}
      onBlur={p.onBlur as never}
      onMdChange={(e) => e.target === e.currentTarget && onChange?.(asChange<HTMLSelectElement>(e as unknown as Event))}
    >
      {items.map((o, i) => (
        <MdSelectOption key={String(o.key ?? i)} value={String(o.props.value ?? textOf(o.props.children))} disabled={o.props.disabled}>
          {textOf(o.props.children) || o.props.label}
        </MdSelectOption>
      ))}
    </MdSelect>
  );
});

const OWN_LABEL = new Set<unknown>([Input, Select, Textarea]);

/**
 * Label + control + hint + error. Material controls draw the label, hint and error inside the
 * field (Material's floating label); other controls get them around it, wired up for screen readers.
 */
export function Field({ label, hint, error, children, required, className }: { label: string; hint?: string; error?: string; required?: boolean; className?: string; children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode }) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(" ") || undefined;
  const control = children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy });
  if (isValidElement<InputProps>(control) && OWN_LABEL.has(control.type) && !(control.type === Input && control.props.type && NATIVE_INPUTS.has(control.props.type))) {
    const isNativeSelect = control.type === Select && Children.toArray((control.props as SelectProps).children).some((o) => isValidElement(o) && o.type === "optgroup");
    if (!isNativeSelect) {
      return (
        <div className={cn("min-w-0", className)}>
          {cloneElement(control, { fieldLabel: label, fieldHint: hint, fieldError: error, fieldRequired: required, id: undefined, "aria-describedby": undefined })}
        </div>
      );
    }
  }
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      {control}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A Material checkbox with its label. A hidden native checkbox stays the source of truth, so
 * react-hook-form (which only treats real checkboxes as booleans) and controlled state both work;
 * the Material checkbox mirrors it.
 */
export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string }>(function Checkbox({ label, className, ...p }, ref) {
  const native = useRef<HTMLInputElement>(null);
  const md = useRef<HTMLMdCheckboxElement>(null);
  useImperativeHandle(ref, () => native.current!, []);
  // Mirror after every render: react-hook-form's reset sets the native box without an event.
  useLayoutEffect(() => {
    if (md.current && native.current) md.current.checked = native.current.checked;
  });
  return (
    <div className={cn("flex min-h-10 items-center", className)}>
      <input ref={native} type="checkbox" className="sr-only" tabIndex={-1} aria-hidden {...p} />
      <label className="inline-flex cursor-pointer items-center gap-1 text-sm">
        <MdCheckbox
          ref={md}
          aria-label={label}
          checked={p.checked ?? p.defaultChecked ?? undefined}
          disabled={p.disabled}
          onMdChange={(e) => {
            const box = native.current;
            if (!box) return;
            // A real click on the native box fires its change event for React and react-hook-form.
            if (box.checked !== e.detail.checked) box.click();
            if (md.current) md.current.checked = box.checked;
          }}
        />
        <span>{label}</span>
      </label>
    </div>
  );
});

/** Several checkboxes that edit one array of values. */
export function CheckboxGroup<T extends string>({ legend, hint, options, labels, value, onChange, disabled, className }: { legend: string; hint?: string; options: readonly T[]; labels: Record<T, string>; value: readonly T[]; onChange: (v: T[]) => void; disabled?: boolean; className?: string }) {
  return (
    <fieldset disabled={disabled} className={cn("space-y-1", className)}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      <div className="flex flex-wrap gap-x-5">
        {options.map((o) => (
          <Checkbox key={o} label={labels[o]} disabled={disabled} checked={value.includes(o)} onChange={(e) => onChange(e.target.checked ? options.filter((x) => x === o || value.includes(x)) : value.filter((x) => x !== o))} />
        ))}
      </div>
    </fieldset>
  );
}

// --- Layout --------------------------------------------------------------------------

/** A Material outlined card surface. */
export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-w-0 rounded-[var(--md-sys-shape-corner-medium)] border border-border bg-surface", className)} {...p} />;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 px-5 pb-2 pt-4", className)}>
      <div className="min-w-0">
        <h2 className="text-base font-medium leading-6 text-balance">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[clamp(1.5rem,1.2rem+1.1vw,2rem)] font-normal leading-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const tones = {
  neutral: "bg-surface-2 text-muted",
  primary: "bg-primary-soft text-[var(--md-sys-color-on-secondary-container)]",
  success: "bg-success-soft text-[var(--md-sys-color-on-success-container)]",
  warning: "bg-warning-soft text-[var(--md-sys-color-on-warning-container)]",
  danger: "bg-danger-soft text-[var(--md-sys-color-on-error-container)]",
  info: "bg-info-soft text-[var(--md-sys-color-on-info-container)]",
  accent: "bg-accent-soft text-[var(--md-sys-color-on-warning-container)]",
} as const;
export type Tone = keyof typeof tones;

/** A small status label (Material assist-chip styling). */
export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-[var(--md-sys-shape-corner-small)] px-2 py-0.5 text-xs font-medium tracking-[0.3px]", tones[tone], className)}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <MdSkeleton className={cn("block", className)} aria-hidden />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-muted [&_svg]:size-8">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Lists rule violations returned by the API (e.g. stage requirements). */
export function IssueList({ issues, title = "Before you can continue:" }: { issues: string[]; title?: string }) {
  if (!issues.length) return null;
  return (
    <div role="alert" className="rounded-[var(--md-sys-shape-corner-small)] bg-warning-soft p-3 text-sm text-[var(--md-sys-color-on-warning-container)]">
      <p className="font-medium">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {issues.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className={cn("tabular mt-1 text-[clamp(1.25rem,1rem+1vw,1.75rem)] font-normal", tone && tone !== "neutral" && "text-primary")}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </Card>
  );
}
