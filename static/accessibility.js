"use strict";

// Preserve existing markup/layout while giving custom click targets native
// button keyboard behaviour. Put this on the action itself, never on a row
// containing other controls (ARIA buttons hide their descendants' semantics).
function makeKeyboardAction(element, label) {
  element.setAttribute("role", "button");
  element.tabIndex = 0;
  if (label) element.setAttribute("aria-label", label);
  element.addEventListener("keydown", (event) => {
    if (event.target !== element || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    element.click();
  });
}

function preferredScrollBehavior() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

const actionMenus = new WeakMap();
function prepareActionMenu(menu, anchor, close) {
  actionMenus.set(menu, { anchor, close });
  anchor?.setAttribute("aria-expanded", "true");
  if (!menu.hasAttribute("aria-label") && !menu.hasAttribute("aria-labelledby")) {
    menu.setAttribute("aria-label", anchor?.getAttribute("aria-label") || anchor?.title || "Actions");
  }
  menu.querySelectorAll("button").forEach((button) => button.setAttribute("role", "menuitem"));
  // Pointer opening retains its existing appearance. Keyboard opening moves
  // directly to the first menu item instead of leaving focus behind it.
  if (anchor?.matches(":focus-visible")) menu.querySelector("button:not([disabled])")?.focus();
}
function restoreActionMenuFocus(menu) {
  actionMenus.get(menu)?.anchor?.setAttribute("aria-expanded", "false");
  if (menu?.contains(document.activeElement)) actionMenus.get(menu)?.anchor?.focus();
}
document.addEventListener("keydown", (event) => {
  const menu = event.target.closest('[role="menu"]');
  const context = menu && actionMenus.get(menu);
  if (!context) return;
  const items = [...menu.querySelectorAll("button:not([disabled])")].filter((el) => el.getClientRects().length);
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const at = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
      (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    context.close();
    context.anchor?.focus();
  } else if (event.key === "Tab") {
    // Close before the browser advances from the trigger, keeping a menu from
    // remaining open after focus leaves its actions.
    context.close();
    context.anchor?.focus();
  }
}, true);

function prepareSummaryHint(element) {
  element.tabIndex = 0;
  element.setAttribute("aria-label", "Preview condensed summary");
}

// Mouse dragging and keyboard resizing call the same size setter. Geometry
// comes from the existing theme/viewport; arrow increments are interaction
// steps, not visual defaults. Shift moves faster; Home/End reach the limits.
function setupResizeHandle(handle, { label, orientation, controls, getValue, getBounds, setValue, reverse = false }) {
  if (!handle) return;
  handle.removeAttribute("aria-hidden");
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", label);
  handle.setAttribute("aria-orientation", orientation);
  handle.setAttribute("aria-controls", controls);
  handle.tabIndex = 0;
  const sync = () => {
    const [min, max] = getBounds();
    handle.setAttribute("aria-valuemin", String(Math.round(min)));
    handle.setAttribute("aria-valuemax", String(Math.round(max)));
    handle.setAttribute("aria-valuenow", String(Math.round(Math.max(min, Math.min(max, getValue())))));
  };
  handle.addEventListener("keydown", (event) => {
    const arrows = orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (![...arrows, "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const [min, max] = getBounds();
    let next;
    if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else next = getValue() + (event.shiftKey ? 50 : 10) * (event.key === arrows[0] ? -1 : 1) * (reverse ? -1 : 1);
    setValue(Math.max(min, Math.min(max, next)));
    sync();
  });
  const observer = new ResizeObserver(sync);
  const pane = document.getElementById(controls);
  if (pane) observer.observe(pane);
  sync();
}

// All existing and dynamically created modal dialogs share this lifecycle.
// Observing hidden/removal also covers async save/cancel paths without forcing
// each feature to duplicate focus trapping, background isolation or restoration.
(() => {
  let active = null;
  let opener = null;
  const ownedInert = new Set();
  const focusable = (dialog) => [...dialog.querySelectorAll(
    'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]',
  )].filter((el) => !el.disabled && el.tabIndex >= 0 && !el.closest("[hidden], [inert]") && el.getClientRects().length);
  const current = () => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .filter((el) => !el.closest("[hidden]") && el.getClientRects().length).at(-1) || null;
  function sync() {
    const next = current();
    if (next === active) return;
    const previousOpener = opener;
    const focusWasInDialog = active?.contains(document.activeElement);
    for (const el of ownedInert) el.inert = false;
    ownedInert.clear();
    active = next;
    opener = null;
    if (!next) {
      if (previousOpener?.isConnected && !previousOpener.closest("[hidden], [inert]")) previousOpener.focus();
      return;
    }
    opener = focusWasInDialog && previousOpener ? previousOpener : document.activeElement;
    // Find the overlay's body child; only its branch stays interactive.
    let branch = next;
    while (branch.parentElement && branch.parentElement !== document.body) branch = branch.parentElement;
    for (const sibling of document.body.children) {
      if (sibling === branch || sibling.inert || ["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) continue;
      sibling.inert = true;
      ownedInert.add(sibling);
    }
    if (!next.contains(document.activeElement)) {
      const target = next.querySelector("[data-dialog-initial-focus]") || focusable(next)[0] || next;
      if (target === next) next.tabIndex = -1;
      target.focus();
    }
  }
  document.addEventListener("keydown", (event) => {
    if (!active) return;
    if (event.key === "Escape") {
      const cancel = active.querySelector("[data-dialog-cancel]");
      if (cancel) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel.click();
      }
    } else if (event.key === "Tab") {
      const items = focusable(active);
      const first = items[0] || active, last = items.at(-1) || active;
      if (!items.length || !active.contains(document.activeElement) ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  }, true);
  document.addEventListener("focusin", (event) => {
    if (active && !active.contains(event.target)) (focusable(active)[0] || active).focus();
  });
  new MutationObserver(sync).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  sync();
})();
