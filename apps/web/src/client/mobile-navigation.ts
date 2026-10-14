/** Small-screen access to the same site links; research navigation stays separate. */
export function createMobileNavigation(options: { doc?: Document } = {}): { dispose(): void } {
  const doc = options.doc ?? document;
  const win = doc.defaultView;
  const canonical = doc.querySelector('.nav-links');
  const actions = doc.querySelector('.nav-actions');
  if (!canonical || !actions) return { dispose() {} };

  function links(className: string): HTMLElement {
    const nav = doc.createElement('nav');
    nav.className = className;
    nav.setAttribute('aria-label', '网站导航');
    canonical!.querySelectorAll<HTMLAnchorElement>('a').forEach(original => {
      const link = doc.createElement('a');
      link.textContent = original.textContent;
      link.setAttribute('href', original.getAttribute('href') ?? '#/');
      nav.append(link);
    });
    return nav;
  }

  const menu = doc.createElement('details');
  menu.className = 'mobile-navigation';
  const summary = doc.createElement('summary');
  summary.textContent = '导航';
  summary.setAttribute('aria-label', '网站导航');
  menu.append(summary, links('mobile-site-links'));
  actions.before(menu);

  const account = doc.querySelector<HTMLDetailsElement>('.account-options');
  const accountLinks = links('account-site-navigation');
  account?.querySelector(':scope > div')?.append(accountLinks);
  const menus = [menu, ...(account ? [account] : [])];
  let disposed = false;

  const close = (): void => { menus.forEach(item => { item.open = false; }); };
  const onLink = (event: Event): void => {
    const target = event.target as Element | null;
    if (target?.closest('a')) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    const current = menus.find(item => item.open && item.contains(doc.activeElement));
    if (!current) return;
    event.preventDefault();
    current.open = false;
    current.querySelector<HTMLElement>('summary')?.focus();
  };
  const onOutside = (event: Event): void => {
    const target = event.target as Node | null;
    if (!menus.some(item => target && item.contains(target))) close();
  };
  const onHide = (event: PageTransitionEvent): void => {
    close();
    if (!event.persisted) dispose();
  };

  menu.addEventListener('click', onLink);
  accountLinks.addEventListener('click', onLink);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('pointerdown', onOutside);
  win?.addEventListener('hashchange', close);
  win?.addEventListener('pagehide', onHide);
  return { dispose };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    menu.removeEventListener('click', onLink);
    accountLinks.removeEventListener('click', onLink);
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('pointerdown', onOutside);
    win?.removeEventListener('hashchange', close);
    win?.removeEventListener('pagehide', onHide);
    menu.remove();
    accountLinks.remove();
  }
}
