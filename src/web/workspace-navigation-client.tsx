'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { signOutAction } from '../../app/actions.ts';
import { isWorkspaceNavigationActive, workspaceNavigation } from './workspace-navigation.ts';
import { ui } from './ui-classes.ts';

function WorkspaceLinks({ pathname, onNavigate, firstLinkRef }: {
  pathname: string;
  onNavigate?: () => void;
  firstLinkRef?: RefObject<HTMLAnchorElement | null>;
}) {
  return <>
    {workspaceNavigation.map(({ href, label }, index) => {
      const active = isWorkspaceNavigationActive(pathname, href);
      return <Link key={href} href={href} aria-current={active ? 'page' : undefined} ref={index === 0 ? firstLinkRef : undefined} {...(onNavigate ? { onClick: onNavigate } : {})}
        className={`flex min-h-11 min-w-0 items-center gap-3 rounded-xl px-3 text-sm font-semibold no-underline transition-colors ${active ? 'bg-green-soft text-green-dark' : 'text-slate-700 hover:bg-paper hover:text-ink'}`}>
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${active ? 'bg-green' : 'bg-slate-300'}`}/>
        <span className="min-w-0 break-words">{label}</span>
      </Link>;
    })}
  </>;
}

function Brand() {
  return <Link className="inline-flex min-w-0 items-center gap-2.5 text-ink no-underline" href="/workspace">
    <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-green font-display text-lg font-extrabold text-white">G</span>
    <span className="font-display text-[19px] font-extrabold tracking-[-0.6px]">GradReach</span>
  </Link>;
}

export function WorkspaceNavigation() {
  const pathname = usePathname();
  const currentPage = workspaceNavigation.find(({ href }) => isWorkspaceNavigationActive(pathname, href))?.label ?? 'Workspace';
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstMobileLinkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    firstMobileLinkRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const desktopBreakpoint = window.matchMedia('(min-width: 1024px)');
    const onBreakpointChange = () => {
      if (desktopBreakpoint.matches) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    desktopBreakpoint.addEventListener('change', onBreakpointChange);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      desktopBreakpoint.removeEventListener('change', onBreakpointChange);
    };
  }, [open]);

  useEffect(() => setOpen(false), [pathname]);

  function closeMenu() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function trapTabKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const controls = event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
    const first = controls.item(0);
    const last = controls.item(controls.length - 1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return <>
    <header className={`sticky top-0 flex min-h-14 items-center justify-between gap-3 border-b border-line bg-white px-4 py-2 shadow-sm sm:px-6 lg:hidden ${open ? 'z-[55]' : 'z-30'}`}>
      <h1 className="m-0 min-w-0 truncate font-display text-base font-bold text-ink">{currentPage}</h1>
      <button ref={triggerRef} className="relative z-[60] inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-white text-ink shadow-sm transition hover:bg-paper" type="button" aria-label={open ? 'Close navigation menu' : 'Open navigation menu'} aria-expanded={open} aria-controls="workspace-mobile-navigation" onClick={() => open ? closeMenu() : setOpen(true)}>
        {open ? <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 6 12 12M18 6 6 18"/></svg> : <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>}
      </button>
    </header>

    <aside aria-label="Workspace navigation" className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-line bg-white px-4 py-5 lg:flex">
      <div className="border-b border-line px-2 pb-5"><Brand/></div>
      <nav aria-label="Owner workspace" className="mt-5 grid gap-1">
        <WorkspaceLinks pathname={pathname}/>
      </nav>
      <div className="mt-auto border-t border-line pt-4">
        <p className="mb-3 px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-green">Owner access</p>
        <form action={signOutAction}><button className={`${ui.secondaryButton} w-full`} type="submit">Sign out</button></form>
      </div>
    </aside>

    {open ? <button className="fixed inset-0 z-40 cursor-default bg-ink/40 lg:hidden" type="button" aria-label="Close navigation menu" tabIndex={-1} onClick={closeMenu}/> : null}
    <aside id="workspace-mobile-navigation" role={open ? 'dialog' : undefined} aria-modal={open ? true : undefined} aria-label="Workspace navigation" hidden={!open} onKeyDown={trapTabKey} className="fixed bottom-0 left-0 top-14 z-50 flex w-[min(88vw,22rem)] flex-col overflow-y-auto border-r border-line bg-white px-4 py-5 shadow-soft lg:hidden">
      <nav aria-label="Owner workspace" className="grid gap-1 border-b border-line pb-4">
        <WorkspaceLinks pathname={pathname} onNavigate={closeMenu} firstLinkRef={firstMobileLinkRef}/>
      </nav>
      <div className="mt-auto border-t border-line pt-4">
        <p className="mb-3 px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-green">Owner access</p>
        <form action={signOutAction}><button className={`${ui.secondaryButton} w-full`} type="submit">Sign out</button></form>
      </div>
    </aside>
  </>;
}
