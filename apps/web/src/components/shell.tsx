"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Building2, CalendarCheck, FileSignature, MessagesSquare, KanbanSquare, LayoutDashboard, ListChecks, LogOut, Menu as MenuIcon, ScanLine, Search, Settings, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ROLE_LABELS } from "@uo/shared";
import { api } from "@/lib/api";
import { cn, ref, relative } from "@/lib/format";
import { useChannels } from "@/lib/chat";
import { useUser } from "@/lib/session";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./ui/overlays";
import { Button } from "./ui/primitives";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/opportunities", label: "Opportunities", icon: ListChecks },
  { href: "/customers", label: "Customers", icon: Building2 },
  { href: "/activities", label: "My tasks", icon: CalendarCheck },
  { href: "/chat", label: "Chat", icon: MessagesSquare },
  { href: "/scan", label: "Scan business card", icon: ScanLine },
];

export function AppShell({ children }: { children: ReactNode }) {
  const user = useUser();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isAdmin = user.capabilities.some((c) => c.startsWith("admin."));
  const unread = useChannels().data?.totalUnread ?? 0;
  useEffect(() => setOpen(false), [pathname]);

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5 p-3">
      {[
        ...NAV,
        ...(user.capabilities.includes("form.template_manage") ? [{ href: "/forms", label: "Supplier forms", icon: FileSignature }] : []),
        ...(isAdmin ? [{ href: "/admin", label: "Administration", icon: Settings }] : []),
      ].map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text", active && "bg-primary-soft text-primary hover:bg-primary-soft hover:text-primary")}
          >
            <Icon className="size-4" aria-hidden />
            {label}
            {href === "/chat" && unread > 0 && (
              <span className="ml-auto rounded-full bg-primary px-1.5 text-xs font-semibold leading-5 text-primary-fg" aria-label={`${unread} unread`}>
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only z-50 rounded bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-2 focus:top-2">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <Brand />
        {nav}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-surface">
            <Brand />
            {nav}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:px-4">
          <Button variant="ghost" size="icon" className="shrink-0 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <MenuIcon />
          </Button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1">
            <Notifications />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex h-14 items-center gap-2 border-b border-border px-5">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-fg">
        <Zap className="size-4" aria-hidden />
      </span>
      <span className="font-semibold">Utility Optimizer</span>
    </Link>
  );
}

interface SearchResults {
  opportunities: { id: string; number: number; name: string; outcome: string; stage: { name: string } }[];
  customers: { id: string; legalName: string; tradingName: string | null }[];
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const { data, isFetching } = useQuery({ queryKey: ["search", debounced], queryFn: () => api.get<SearchResults>(`/search?q=${encodeURIComponent(debounced)}`), enabled: debounced.length >= 2 });
  const go = (href: string) => {
    setOpen(false);
    setQ("");
    router.push(href);
  };
  const empty = data && !data.opportunities.length && !data.customers.length;

  return (
    <div ref={box} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder="Search customers, opportunities, MPRN…"
        aria-label="Search"
        className="h-9 w-full rounded-lg border border-border bg-surface-2 pl-9 pr-3 text-sm"
      />
      {open && debounced.length >= 2 && (
        <div className="absolute left-0 right-0 top-11 z-50 max-h-96 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg" role="listbox" aria-label="Search results">
          {isFetching && !data && <p className="px-3 py-2 text-sm text-muted">Searching…</p>}
          {empty && <p className="px-3 py-2 text-sm text-muted">No matches for “{debounced}”.</p>}
          {!!data?.opportunities.length && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted">Opportunities</p>}
          {data?.opportunities.map((o) => (
            <button key={o.id} role="option" aria-selected={false} onClick={() => go(`/opportunities/${o.id}`)} className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2">
              <span className="truncate">
                <span className="text-muted">{ref(o.number)}</span> {o.name}
              </span>
              <span className="shrink-0 text-xs text-muted">{o.outcome === "open" ? o.stage.name : o.outcome}</span>
            </button>
          ))}
          {!!data?.customers.length && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted">Customers</p>}
          {data?.customers.map((c) => (
            <button key={c.id} role="option" aria-selected={false} onClick={() => go(`/customers/${c.id}`)} className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2">
              {c.legalName}
              {c.tradingName && <span className="text-muted"> · {c.tradingName}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Notification {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

function Notifications() {
  const qc = useQueryClient();
  const router = useRouter();
  const count = useQuery({ queryKey: ["notifications", "count"], queryFn: () => api.get<{ count: number }>("/notifications/unread-count"), refetchInterval: 60_000 });
  const list = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<Notification[]>("/notifications") });
  const markRead = useMutation({
    mutationFn: (ids: string[] | "all") => api.post("/notifications/read", { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const n = count.data?.count ?? 0;

  return (
    <Menu onOpenChange={(o) => o && list.refetch()}>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={n ? `Notifications, ${n} unread` : "Notifications"} className="relative">
          <Bell />
          {n > 0 && <span className="absolute right-1 top-1 min-w-[1.125rem] rounded-full bg-danger px-1 text-center text-xs font-semibold leading-[1.125rem] text-white">{n > 9 ? "9+" : n}</span>}
        </Button>
      </MenuTrigger>
      <MenuContent>
        <div className="flex w-80 items-center justify-between px-2.5 py-1.5">
          <span className="text-sm font-semibold">Notifications</span>
          {n > 0 && (
            <button className="text-xs text-primary hover:underline" onClick={() => markRead.mutate("all")}>
              Mark all read
            </button>
          )}
        </div>
        <MenuSeparator />
        {!list.data?.length && <p className="px-3 py-6 text-center text-sm text-muted">You're all caught up.</p>}
        {list.data?.slice(0, 15).map((x) => (
          <MenuItem
            key={x.id}
            onSelect={() => {
              if (!x.readAt) markRead.mutate([x.id]);
              if (x.link) router.push(x.link);
            }}
          >
            <div className="flex w-72 items-start gap-2">
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", x.readAt ? "bg-transparent" : "bg-primary")} aria-hidden />
              <div className="min-w-0">
                <p className={cn("truncate", !x.readAt && "font-medium")}>{x.title}</p>
                {x.body && <p className="line-clamp-2 text-xs text-muted">{x.body}</p>}
                <p className="text-xs text-muted">{relative(x.createdAt)}</p>
              </div>
            </div>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function UserMenu() {
  const user = useUser();
  const router = useRouter();
  const qc = useQueryClient();
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  const setTheme = (t: "light" | "dark" | "system") => {
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("uo-theme", t);
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="flex size-9 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary" aria-label={`Account: ${user.name}`}>
          {initials}
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>
          <span className="block text-sm font-medium text-text">{user.name}</span>
          {user.roles.map((r) => ROLE_LABELS[r]).join(", ")}
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => router.push("/account")}>Security, 2FA &amp; phone</MenuItem>
        <MenuItem onSelect={() => setTheme("light")}>Light theme</MenuItem>
        <MenuItem onSelect={() => setTheme("dark")}>Dark theme</MenuItem>
        <MenuItem onSelect={() => setTheme("system")}>Use system theme</MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={async () => {
            await api.post("/auth/logout").catch(() => undefined);
            qc.clear();
            router.replace("/login");
          }}
        >
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
