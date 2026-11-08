// The page owns vertical scrolling. Keep the native sticky header outside the
// body's horizontal scroller, and synchronize only horizontal position/widths.
export function initDirectoryTableHeader(results: HTMLElement) {
  const siteHeader = document.querySelector<HTMLElement>(".site-header");
  let shell: HTMLElement | null = null;
  let frame: HTMLElement | null = null;
  let table: HTMLTableElement | null = null;
  let header: HTMLElement | null = null;
  let headerTable: HTMLTableElement | null = null;
  let scheduled: number | undefined;
  let needsMeasurement = true;
  let active = true;
  let start = 0;
  let scrollLeft = 0;

  const syncFromBody = () => {
    if (!frame || !header || Math.abs(frame.scrollLeft - scrollLeft) < 0.5)
      return;
    scrollLeft = frame.scrollLeft;
    header.scrollLeft = scrollLeft;
  };
  const syncFromHeader = () => {
    if (!frame || !header || Math.abs(header.scrollLeft - scrollLeft) < 0.5)
      return;
    scrollLeft = header.scrollLeft;
    frame.scrollLeft = scrollLeft;
  };

  const update = () => {
    scheduled = undefined;
    if (!shell?.isConnected || !frame || !table || !header || !headerTable)
      return;
    if (needsMeasurement) {
      // The body's non-interactive semantic header also retains the intrinsic
      // column sizes. Only the separate visual table gets fixed column widths.
      const bounds = table.getBoundingClientRect();
      const widths = [...table.tHead!.rows[0].cells].map(
        (cell) => cell.getBoundingClientRect().width,
      );
      const height = headerTable.tHead!.getBoundingClientRect().height;
      const top = siteHeader?.getBoundingClientRect().height ?? 0;
      start = shell.getBoundingClientRect().top + window.scrollY - top;
      const overflowing = bounds.width > frame.clientWidth;
      needsMeasurement = false;

      headerTable.style.width = `${bounds.width}px`;
      [...headerTable.querySelectorAll("col")].forEach((col, index) => {
        col.style.width = `${widths[index]}px`;
      });
      shell.style.setProperty("--directory-table-header-height", `${height}px`);
      shell.style.setProperty("--directory-table-header-top", `${top}px`);
      frame.tabIndex = overflowing ? 0 : -1;
      scrollLeft = frame.scrollLeft;
      header.scrollLeft = scrollLeft;
    }
    // Cosmetic corner changes only; native sticky owns all vertical positioning.
    const stuck = String(window.scrollY > start);
    if (shell.dataset.headerStuck !== stuck) shell.dataset.headerStuck = stuck;
  };
  function schedule() {
    if (active) scheduled ??= requestAnimationFrame(update);
  }
  const measure = () => {
    needsMeasurement = true;
    schedule();
  };
  const observer = new ResizeObserver(measure);
  const disconnect = () => {
    observer.disconnect();
    window.removeEventListener("scroll", schedule);
    frame?.removeEventListener("scroll", syncFromBody);
    header?.removeEventListener("scroll", syncFromHeader);
    if (scheduled !== undefined) cancelAnimationFrame(scheduled);
    scheduled = undefined;
  };

  const refresh = () => {
    disconnect();
    shell = results.querySelector<HTMLElement>(".volunteer-table-shell");
    frame = shell?.querySelector<HTMLElement>(".volunteer-table-frame") ?? null;
    table = frame?.querySelector<HTMLTableElement>("table") ?? null;
    if (!shell || !frame || !table?.tHead) return;
    header = shell.querySelector<HTMLElement>(".volunteer-table-header");
    if (!header) {
      const head = table.tHead;
      const height = head.getBoundingClientRect().height;
      const semanticHead = head.cloneNode(true) as HTMLTableSectionElement;
      // Keep real column headers in the data table, but only one set of sort
      // controls. The original links move into the visible presentation table.
      semanticHead.querySelectorAll("a").forEach((link) => {
        const label = document.createElement("span");
        label.className = link.className;
        label.replaceChildren(...link.childNodes);
        link.replaceWith(label);
      });
      table.replaceChild(semanticHead, head);
      header = document.createElement("div");
      header.className = "volunteer-table-header";
      header.setAttribute("role", "group");
      header.setAttribute(
        "aria-label",
        `${frame.getAttribute("aria-label")} sorting`,
      );
      headerTable = document.createElement("table");
      headerTable.className = "volunteer-table";
      headerTable.setAttribute("role", "presentation");
      const columns = document.createElement("colgroup");
      for (const _ of head.rows[0].cells)
        columns.appendChild(document.createElement("col"));
      headerTable.appendChild(columns);
      headerTable.appendChild(head);
      header.appendChild(headerTable);
      shell.insertBefore(header, frame);
      shell.style.setProperty("--directory-table-header-height", `${height}px`);
      shell.dataset.tableHeader = "split";
    }
    headerTable = header.querySelector<HTMLTableElement>("table");
    observer.observe(frame);
    observer.observe(table);
    observer.observe(header);
    observer.observe(table.tHead);
    observer.observe(results.closest("[data-volunteer-browser]") ?? results);
    if (siteHeader) observer.observe(siteHeader);
    frame.addEventListener("scroll", syncFromBody, { passive: true });
    header.addEventListener("scroll", syncFromHeader, { passive: true });
    window.addEventListener("scroll", schedule, { passive: true });
    measure();
  };
  const resume = () => {
    active = true;
    refresh();
  };
  window.addEventListener("pagehide", () => {
    active = false;
    disconnect();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resume();
  });
  resume();
  return refresh;
}
