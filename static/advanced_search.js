"use strict";

// Advanced Search is a session-only workspace. The configuration and results
// survive closing/reopening this screen, but intentionally reset on page reload.
// Recent and saved searches are the durable exception and live in userdata.db.
(() => {
  const panel = $("advanced-search-panel");
  const filtersEl = $("advanced-filter-content");
  const queryEl = $("advanced-query");
  const queryClear = $("advanced-query-clear");
  const resultsPanel = $("advanced-results-panel");
  const resultsList = $("advanced-results-list");
  const resultsCount = $("advanced-results-count");
  const resultsStatus = $("advanced-results-status");
  const sortEl = $("advanced-sort");
  const resultViewEl = $("advanced-result-view");
  const listModelsBtn = $("advanced-list-models");
  const recentList = $("advanced-recent-list");
  const savedList = $("advanced-saved-list");
  const upBtn = $("advanced-results-up");
  const downBtn = $("advanced-results-down");
  const resizeHandle = $("advanced-results-resize");

  if (!panel || !resultsPanel) return;

  const SOURCE_OPTIONS = [
    ["titles", "Titles"],
    ["user_messages", "User Messages"],
    ["ai_messages", "AI Messages"],
    ["attachments", "Attachments"],
    ["summary", "Summary"],
    ["condensed", "Condensed Summary"],
    ["user_notes", "User Notes"],
    ["notes_to_ai", "Notes to AI"],
    ["notes_from_ai", "Notes from AI"],
    ["bookmarks", "Bookmarks"],
  ];

  // Date choices, as in the concept design. The day counts are relative to
  // the day the search runs, so a saved "7 days" always means the last week.
  const DATE_RANGES = [
    ["any", "Any time"],
    ["7", "7 days"],
    ["30", "30 days"],
    ["90", "90 days"],
    ["custom", "Custom"],
  ];

  const blankFilter = () => ({ include: [], exclude: [], none: false });
  const defaultCriteria = () => ({
    query: "",
    text_mode: "all",
    whole_words: false,
    providers: [state.providerSide === "chatgpt" ? "chatgpt" : "claude"],
    search_in: { include: [], exclude: [] },
    filters: {
      tags: blankFilter(),
      mood_tags: blankFilter(),
      labels: blankFilter(),
      // Kept per provider: switching provider keeps the other side's
      // folder choices for when the user switches back.
      claude_folders: blankFilter(),
      chatgpt_folders: blankFilter(),
      claude_models: blankFilter(),
      chatgpt_models: blankFilter(),
      gizmos: blankFilter(),
    },
    statuses: ["active"],
    pinned_only: false,
    date: { range: "any", from: "", to: "" },
    must_have: [],
    sort: "newest",
  });

  const ui = {
    open: false,
    loaded: false,
    initializedCriteria: false,
    busy: false,
    options: {},
    history: { recent: [], saved: [] },
    criteria: defaultCriteria(),
    editModes: {},
    allStash: {},
    results: [],
    total: 0,
    hasRun: false,
    lastSearchKey: null,
    pendingSearch: null,
    // The location being listed (a folder, Archived or Deleted) when the
    // results show a location instead of a search.
    browse: null,
    resultView: "default",
    listModels: false,
    resultSize: "default",
    collapsed: {},
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeCriteria(raw) {
    const base = defaultCriteria();
    const incoming = raw && typeof raw === "object" ? clone(raw) : {};
    const merged = { ...base, ...incoming };
    merged.providers = Array.isArray(incoming.providers)
      ? incoming.providers.filter((v) => v === "claude" || v === "chatgpt")
      : base.providers;
    if (!merged.providers.length) merged.providers = base.providers;
    merged.search_in = { ...base.search_in, ...(incoming.search_in || {}) };
    merged.filters = {};
    for (const key of Object.keys(base.filters)) {
      const value = (incoming.filters || {})[key] || {};
      merged.filters[key] = {
        include: Array.isArray(value.include) ? value.include.map(String) : [],
        exclude: Array.isArray(value.exclude) ? value.exclude.map(String) : [],
        none: Boolean(value.none),
      };
    }
    merged.statuses = Array.isArray(incoming.statuses)
      ? incoming.statuses.filter((v) => ["active", "archived", "deleted"].includes(v))
      : ["active"];
    if (!merged.statuses.length) merged.statuses = ["active"];
    merged.date = { ...base.date, ...(incoming.date || {}) };
    if (!DATE_RANGES.some(([value]) => value === merged.date.range)) {
      merged.date.range = merged.date.from || merged.date.to ? "custom" : "any";
    }
    merged.must_have = Array.isArray(incoming.must_have) ? incoming.must_have : [];
    merged.text_mode = ["all", "any", "exact"].includes(incoming.text_mode)
      ? incoming.text_mode
      : "all";
    merged.sort = ["newest", "oldest", "matches"].includes(incoming.sort)
      ? incoming.sort
      : "newest";
    return merged;
  }

  function option(value, label = value, extra = {}) {
    return { value: String(value), label: String(label), ...extra };
  }

  // Section icons from the concept design (advanced-search-desktop.html).
  const SECTION_ICONS = {
    "search-in": '<svg class="advanced-filter-icon" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 3.5h10M2 7h7M2 10.5h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    tags: '<svg class="advanced-filter-icon" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 4C2 3.45 2.45 3 3 3H6.09c.27 0 .52.1.71.29L12.5 9a1 1 0 010 1.41l-3.59 3.59a1 1 0 01-1.41 0L1.79 8.29A1 1 0 011.5 7.59V4z" stroke="currentColor" stroke-width="1.2"/><circle cx="4.5" cy="5.5" r=".8" fill="currentColor"/></svg>',
    organization: '<svg class="advanced-filter-icon" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 4C2 3.45 2.45 3 3 3H5.5L7 4.5H11c.55 0 1 .45 1 1V10.5c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V4z" stroke="currentColor" stroke-width="1.2"/></svg>',
    models: '<svg class="advanced-filter-icon" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M12.25 1.75H1.75l4.38 5.17v3.58l1.75.88V6.92l4.37-5.17z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "status-date": '<svg class="advanced-filter-icon" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 2v1.5M9.5 2v1.5M2 5.5h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  };

  function fixedSvgChevron() {
    return '<svg class="advanced-filter-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7 5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  let sectionBadges = {};

  // Values selected in a filter. "All" and "None" select no values, so
  // neither adds to the count.
  function filterCount(filter) {
    if (!filter || filter.none) return 0;
    return filter.include.filter((value) => value !== ALL).length + filter.exclude.length;
  }

  function sectionCounts() {
    const c = ui.criteria;
    const f = c.filters;
    const claude = c.providers.includes("claude");
    const chatgpt = c.providers.includes("chatgpt");
    const statusChanged = !(c.statuses.length === 1 && c.statuses[0] === "active");
    return {
      "search-in": filterCount(c.search_in) + c.must_have.length,
      tags: filterCount(f.tags) + filterCount(f.mood_tags),
      organization: filterCount(f.labels)
        + (claude ? filterCount(f.claude_folders) : 0)
        + (chatgpt ? filterCount(f.chatgpt_folders) : 0),
      models: (claude ? filterCount(f.claude_models) : 0)
        + (chatgpt ? filterCount(f.chatgpt_models) + filterCount(f.gizmos) : 0),
      "status-date": Number(statusChanged) + Number(Boolean(c.pinned_only))
        + (c.date.range === "custom"
          ? Number(Boolean(c.date.from)) + Number(Boolean(c.date.to))
          : Number(c.date.range !== "any")),
    };
  }

  function updateBadges() {
    const counts = sectionCounts();
    for (const [id, badge] of Object.entries(sectionBadges)) {
      const n = counts[id] || 0;
      badge.hidden = !n;
      badge.textContent = String(n);
      badge.setAttribute("aria-label", `${n} active filter${n === 1 ? "" : "s"}`);
    }
  }

  function makeSection(title, id, collapsed = false) {
    const isCollapsed = Object.hasOwn(ui.collapsed, id)
      ? ui.collapsed[id]
      : collapsed;
    const section = document.createElement("section");
    section.className = "advanced-filter-section";
    section.dataset.collapsed = isCollapsed ? "true" : "false";
    section.dataset.section = id;
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "advanced-filter-heading";
    heading.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    if (SECTION_ICONS[id]) heading.insertAdjacentHTML("beforeend", SECTION_ICONS[id]);
    const label = document.createElement("span");
    label.className = "advanced-filter-title";
    label.textContent = title;
    // Count of active filters inside, as in the concept design.
    const badge = document.createElement("span");
    badge.className = "advanced-filter-badge";
    badge.hidden = true;
    sectionBadges[id] = badge;
    heading.append(label, badge);
    heading.insertAdjacentHTML("beforeend", fixedSvgChevron());
    const body = document.createElement("div");
    body.className = "advanced-filter-body";
    heading.addEventListener("click", () => {
      const next = section.dataset.collapsed !== "true";
      ui.collapsed[id] = next;
      section.dataset.collapsed = next ? "true" : "false";
      heading.setAttribute("aria-expanded", next ? "false" : "true");
    });
    section.append(heading, body);
    return { section, body };
  }

  function makeGroup(title) {
    const group = document.createElement("div");
    group.className = "advanced-filter-group";
    if (title) {
      const heading = document.createElement("div");
      heading.className = "advanced-filter-group-title";
      heading.textContent = title;
      group.appendChild(heading);
    }
    return group;
  }

  // "All" is stored as this include value. The server treats it as no
  // include restriction, so only the excluded values (if any) filter.
  const ALL = "__all__";
  const ALL_LABEL = "All Except Excluded";
  const hasAll = (filter) => filter.include.includes(ALL);

  function selectedModeFor(key, filter) {
    if (filter.none) return "none";
    const current = ui.editModes[key];
    if (current === "include" || current === "exclude") return current;
    if (hasAll(filter)) return "all";
    if (filter.include.length) return "include";
    if (filter.exclude.length) return "exclude";
    return "all";
  }

  // Turning All on remembers the selections it replaces; turning it off puts
  // them back, so All can be tried without losing earlier choices.
  function enterAll(key, filter, keepExcludes) {
    if (!hasAll(filter)) {
      ui.allStash[key] = { include: [...filter.include], exclude: [...filter.exclude] };
    }
    filter.none = false;
    filter.include = [ALL];
    if (!keepExcludes) filter.exclude = [];
    delete ui.editModes[key];
  }

  function exitAll(key, filter, restoreExcludes) {
    const saved = ui.allStash[key];
    filter.include = saved ? [...saved.include] : [];
    if (restoreExcludes) filter.exclude = saved ? [...saved.exclude] : [];
    delete ui.allStash[key];
  }

  function makeModeBar(key, filter, allowNone, usePills, onChange) {
    const row = document.createElement("div");
    row.className = "advanced-mode-row";
    const bar = document.createElement("div");
    bar.className = "advanced-segmented";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", `${key} include or exclude mode`);
    const modes = [["include", "Include"], ["exclude", "Exclude"], ["all", "All"]];
    if (allowNone) modes.push(["none", "None"]);
    const active = selectedModeFor(key, filter);
    for (const [value, label] of modes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.setAttribute("aria-pressed", String(active === value));
      btn.addEventListener("click", () => {
        if (value === "all") {
          // Chips show every option active, which can't also show excludes.
          // The dropdown's All Except Excluded chip works alongside them.
          enterAll(key, filter, !usePills);
        } else if (value === "none") {
          filter.include = [];
          filter.exclude = [];
          filter.none = true;
          delete ui.allStash[key];
          ui.editModes[key] = "none";
        } else {
          if (usePills && hasAll(filter)) exitAll(key, filter, true);
          filter.none = false;
          ui.editModes[key] = value;
        }
        onChange();
      });
      bar.appendChild(btn);
    }
    row.appendChild(bar);
    return row;
  }

  // Include and Exclude are separate screens: an option shows active only for
  // the list of the screen being viewed. All shows every option active.
  function activeOnScreen(screen, filter, value) {
    if (screen === "all") return true;
    if (screen === "include" || screen === "exclude") return filter[screen].includes(value);
    return false;
  }

  function addAssignment(key, filter, value, usePills) {
    let mode = selectedModeFor(key, filter);
    if (mode !== "include" && mode !== "exclude") {
      // Picking an option while All or None is selected starts an Include
      // selection, so the click always takes effect.
      mode = "include";
      ui.editModes[key] = mode;
    }
    if (mode === "include" && hasAll(filter)) exitAll(key, filter, usePills);
    filter.none = false;
    const other = mode === "include" ? "exclude" : "include";
    filter[other] = filter[other].filter((item) => item !== value);
    if (!filter[mode].includes(value)) filter[mode].push(value);
  }

  function removeAssignment(filter, value) {
    filter.include = filter.include.filter((item) => item !== value);
    filter.exclude = filter.exclude.filter((item) => item !== value);
  }

  function renderSelectedChips(container, key, filter, optionMap, rerender) {
    container.innerHTML = "";
    const screen = selectedModeFor(key, filter);
    const lists = screen === "exclude" ? ["exclude"] : screen === "none" ? [] : ["include"];
    for (const mode of lists) {
      for (const value of filter[mode]) {
        const chip = document.createElement("span");
        chip.className = "advanced-selected-chip";
        const text = document.createElement("span");
        const known = optionMap.get(value);
        const isLabel = value !== ALL && known && "color" in known;
        const label = value === ALL ? ALL_LABEL : isLabel ? labelAccessibleName({ name: known.label }) : known?.label || value;
        if (isLabel) {
          text.append(`${mode === "include" ? "Include" : "Exclude"}: `, labelChip({ name: known.label, color: known.color }));
        } else {
          text.textContent = value === ALL ? label : `${mode === "include" ? "Include" : "Exclude"}: ${label}`;
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = isLabel && !String(known.label || "").trim() ? "Remove" : `Remove ${label}`;
        remove.setAttribute("aria-label", `Remove ${label}`);
        remove.addEventListener("click", () => {
          if (value === ALL) exitAll(key, filter, false);
          else removeAssignment(filter, value);
          rerender();
        });
        chip.append(text, remove);
        container.appendChild(chip);
      }
    }
  }

  function renderChoiceGroup(parent, { key, title, filter, options, allowNone = true, alwaysDropdown = false, alwaysChips = false, knownLabels = new Map() }) {
    const group = makeGroup(title);
    const rerender = () => renderFilters();
    const normalized = options.map((item) =>
      typeof item === "string" ? option(item) : item,
    );
    const usePills = alwaysChips || (!alwaysDropdown && normalized.length <= 8);
    group.appendChild(makeModeBar(key, filter, allowNone, usePills, rerender));
    const map = new Map(normalized.map((item) => [item.value, item]));
    // Selections that are no longer offered still filter the search, so they
    // stay visible (and removable) instead of applying unseen.
    const stale = [...filter.include, ...filter.exclude]
      .filter((value) => value !== ALL && !map.has(value))
      .map((value) => option(value, knownLabels.get(value) || value));
    for (const item of stale) map.set(item.value, item);

    if (!normalized.length && !stale.length) {
      const empty = document.createElement("div");
      empty.className = "advanced-empty-note";
      empty.textContent = "No options have been identified yet.";
      group.appendChild(empty);
      parent.appendChild(group);
      return;
    }

    if (usePills) {
      const pills = document.createElement("div");
      pills.className = "advanced-option-pills advanced-chip-box";
      const screen = selectedModeFor(key, filter);
      for (const item of normalized.concat(stale)) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "advanced-option-pill";
        if ("color" in item) btn.appendChild(labelChip({ name: item.label, color: item.color }));
        else btn.textContent = item.label;
        const active = activeOnScreen(screen, filter, item.value);
        btn.setAttribute("aria-pressed", String(active));
        if (active && screen === "exclude") btn.dataset.assignment = "exclude";
        const isLabel = "color" in item;
        const prefix = active && screen !== "all"
          ? `${screen === "include" ? "Included" : "Excluded"}: `
          : "";
        // An unnamed label's colour speaks for itself: no hover text for it.
        // Screen readers still get a spoken name.
        if (!isLabel || String(item.label || "").trim()) btn.title = prefix + item.label;
        if (isLabel) btn.setAttribute("aria-label", prefix + labelAccessibleName({ name: item.label }));
        btn.addEventListener("click", () => {
          // While All is on, any chip click leaves All and restores the
          // selections from before it.
          if (hasAll(filter)) exitAll(key, filter, true);
          else if (screen === "all") ui.editModes[key] = "include";
          else if (active) filter[screen] = filter[screen].filter((v) => v !== item.value);
          else addAssignment(key, filter, item.value, true);
          rerender();
        });
        pills.appendChild(btn);
      }
      group.appendChild(pills);
    } else {
      const addRow = document.createElement("div");
      addRow.className = "advanced-select-add";
      const mode = selectedModeFor(key, filter);
      const choices = mode === "include" && !hasAll(filter)
        ? [option(ALL, ALL_LABEL)].concat(normalized)
        : normalized;
      const control = document.createElement("select");
      control.setAttribute("aria-label", `${title} choice`);
      for (const item of choices) {
        const opt = document.createElement("option");
        opt.value = item.value;
        opt.textContent = item.label;
        control.appendChild(opt);
      }
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "Add";
      add.addEventListener("click", () => {
        if (control.value === ALL) enterAll(key, filter, true);
        else addAssignment(key, filter, control.value, false);
        rerender();
      });
      addRow.append(control, add);
      group.appendChild(addRow);
      const chips = document.createElement("div");
      chips.className = "advanced-chip-area advanced-chip-box";
      renderSelectedChips(chips, key, filter, map, rerender);
      group.appendChild(chips);
    }
    parent.appendChild(group);
  }

  function renderProviders(parent) {
    const group = makeGroup();
    const row = document.createElement("div");
    row.className = "advanced-mode-row";
    const bar = document.createElement("div");
    bar.className = "advanced-segmented";
    const isBoth = ui.criteria.providers.length === 2;
    for (const [value, label] of [["claude", "Claude"], ["chatgpt", "ChatGPT"], ["both", "Both"]]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      const active = value === "both" ? isBoth : !isBoth && ui.criteria.providers[0] === value;
      btn.setAttribute("aria-pressed", String(active));
      btn.addEventListener("click", () => {
        ui.criteria.providers = value === "both" ? ["chatgpt", "claude"] : [value];
        renderFilters();
      });
      bar.appendChild(btn);
    }
    row.appendChild(bar);
    group.appendChild(row);
    parent.appendChild(group);
  }

  function renderSearchIn(parent) {
    renderProviders(parent);
    const filter = ui.criteria.search_in;
    filter.none = false;
    renderChoiceGroup(parent, {
      key: "search_in",
      title: "Text Locations",
      filter,
      options: SOURCE_OPTIONS.map(([value, label]) => option(value, label)),
      allowNone: false,
    });
    const other = makeGroup("Other");
    const grid = document.createElement("div");
    grid.className = "advanced-checkbox-grid";
    for (const [value, label] of [["summary", "Must Have Summary"], ["notes", "Must Have Notes"], ["bookmarks", "Must Have Bookmarks"], ["attachments", "Must Have Attachments"]]) {
      const row = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = ui.criteria.must_have.includes(value);
      input.addEventListener("change", () => {
        ui.criteria.must_have = input.checked
          ? [...new Set([...ui.criteria.must_have, value])]
          : ui.criteria.must_have.filter((item) => item !== value);
        updateBadges();
      });
      row.append(input, document.createTextNode(label));
      grid.appendChild(row);
    }
    other.appendChild(grid);
    parent.appendChild(other);
  }

  // A label shown as the app's .label-chip: its colour square, plus its name
  // when it has one. Display only; clicking it never changes a conversation.
  function labelChip(label, showName = true) {
    const chip = document.createElement("span");
    chip.className = "label-chip";
    const square = document.createElement("span");
    square.className = "label-square";
    setLabelColor(square, label.color);
    chip.appendChild(square);
    const name = String(label.name || "").trim();
    if (showName && name) {
      const text = document.createElement("span");
      text.className = "label-text";
      text.textContent = name;
      chip.appendChild(text);
    }
    return chip;
  }

  function labelOptions() {
    return (ui.options.labels || []).map((item) => option(item.id, item.name, { color: item.color }));
  }

  function folderOptions(provider) {
    return (ui.options.folders || [])
      .filter((item) => item.provider === provider)
      .map((item) => option(item.id, item.name));
  }

  function renderModels(parent) {
    const providers = ui.criteria.providers;
    if (providers.includes("claude") && (ui.options.claude_models || []).length) {
      const models = [option("__unidentified__", "Unidentified")].concat(
        ui.options.claude_models.map((item) => option(item.id, item.name)),
      );
      renderChoiceGroup(parent, {
        key: "claude_models",
        title: "Claude Models",
        filter: ui.criteria.filters.claude_models,
        options: models,
        allowNone: false,
        alwaysDropdown: true,
      });
    }
    if (providers.includes("chatgpt")) {
      renderChoiceGroup(parent, {
        key: "chatgpt_models",
        title: "ChatGPT Models",
        filter: ui.criteria.filters.chatgpt_models,
        options: (ui.options.chatgpt_models || []).map((item) => option(item)),
        allowNone: false,
        alwaysDropdown: true,
      });
      renderChoiceGroup(parent, {
        key: "gizmos",
        title: "Gizmos",
        filter: ui.criteria.filters.gizmos,
        options: (ui.options.gizmos || []).map((item) => option(item.id, item.name)),
        allowNone: true,
        alwaysDropdown: true,
      });
    }
  }

  function renderStatusDate(parent) {
    const status = makeGroup("Conversation Status");
    const statusChips = document.createElement("div");
    statusChips.className = "advanced-option-pills";
    const chip = (label, pressed, onClick) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "advanced-option-pill";
      btn.textContent = label;
      btn.setAttribute("aria-pressed", String(pressed));
      btn.addEventListener("click", () => {
        onClick();
        renderFilters();
      });
      statusChips.appendChild(btn);
    };
    for (const [value, label] of [["active", "Active"], ["archived", "Archived"], ["deleted", "Recycle Bin"]]) {
      const on = ui.criteria.statuses.includes(value);
      chip(label, on, () => {
        // Several statuses can be on together; at least one always stays on.
        const next = on
          ? ui.criteria.statuses.filter((item) => item !== value)
          : [...ui.criteria.statuses, value];
        if (next.length) ui.criteria.statuses = next;
      });
    }
    const divider = document.createElement("span");
    divider.className = "advanced-chip-divider";
    divider.setAttribute("aria-hidden", "true");
    statusChips.appendChild(divider);
    chip("Pinned only", Boolean(ui.criteria.pinned_only), () => {
      ui.criteria.pinned_only = !ui.criteria.pinned_only;
    });
    status.appendChild(statusChips);
    parent.appendChild(status);

    const dates = makeGroup("Last Activity Date");
    const date = ui.criteria.date;
    const chips = document.createElement("div");
    chips.className = "advanced-option-pills";
    for (const [value, label] of DATE_RANGES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "advanced-option-pill";
      btn.textContent = label;
      btn.setAttribute("aria-pressed", String(date.range === value));
      btn.addEventListener("click", () => {
        // Any time clears the date filter; Custom shows the two date boxes.
        date.range = value;
        renderFilters();
      });
      chips.appendChild(btn);
    }
    dates.appendChild(chips);

    const range = document.createElement("div");
    range.className = "advanced-date-range";
    range.hidden = date.range !== "custom";
    const dateInputs = {};
    // From can't be after To (and To not before From), so the range can't
    // be backwards. Either box may be left empty.
    const syncDateLimits = () => {
      dateInputs.from.max = date.to || "";
      dateInputs.to.min = date.from || "";
    };
    for (const [key, label] of [["from", "From date"], ["to", "To date"]]) {
      const input = document.createElement("input");
      input.type = "date";
      input.value = date[key] || "";
      input.setAttribute("aria-label", label);
      input.addEventListener("change", () => {
        date[key] = input.value;
        syncDateLimits();
        updateBadges();
      });
      dateInputs[key] = input;
      if (key === "to") {
        const sep = document.createElement("span");
        sep.className = "advanced-date-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "→";
        range.appendChild(sep);
      }
      range.appendChild(input);
    }
    syncDateLimits();
    dates.appendChild(range);

    const note = document.createElement("div");
    note.className = "advanced-date-note";
    note.textContent = "Filters by conversation's last activity date";
    dates.appendChild(note);
    parent.appendChild(dates);
  }

  function renderFilters() {
    filtersEl.innerHTML = "";
    sectionBadges = {};

    const searchIn = makeSection("Search In", "search-in");
    renderSearchIn(searchIn.body);
    filtersEl.appendChild(searchIn.section);

    const tags = makeSection("Tags", "tags");
    renderChoiceGroup(tags.body, { key: "tags", title: "Tags", filter: ui.criteria.filters.tags, options: ui.options.tags || [] });
    renderChoiceGroup(tags.body, { key: "mood_tags", title: "Mood Tags", filter: ui.criteria.filters.mood_tags, options: ui.options.mood_tags || [] });
    filtersEl.appendChild(tags.section);

    const organization = makeSection("Labels & Folders", "organization");
    // Labels are always chips: each shows its colour, which a dropdown can't.
    renderChoiceGroup(organization.body, { key: "labels", title: "Labels", filter: ui.criteria.filters.labels, options: labelOptions(), alwaysChips: true });
    const folderNames = new Map((ui.options.folders || []).map((item) => [item.id, item.name]));
    const bothProviders = ui.criteria.providers.length > 1;
    for (const [provider, name] of [["claude", "Claude"], ["chatgpt", "ChatGPT"]]) {
      if (!ui.criteria.providers.includes(provider)) continue;
      renderChoiceGroup(organization.body, {
        key: `${provider}_folders`,
        title: bothProviders ? `${name} Folders` : "Folders",
        filter: ui.criteria.filters[`${provider}_folders`],
        options: folderOptions(provider),
        knownLabels: folderNames,
      });
    }
    filtersEl.appendChild(organization.section);

    const hasClaude = ui.criteria.providers.includes("claude") && (ui.options.claude_models || []).length;
    const hasChatGPT = ui.criteria.providers.includes("chatgpt");
    if (hasClaude || hasChatGPT) {
      const models = makeSection("Models", "models");
      renderModels(models.body);
      filtersEl.appendChild(models.section);
    }

    const status = makeSection("Status & Date", "status-date", true);
    renderStatusDate(status.body);
    filtersEl.appendChild(status.section);
    updateBadges();
  }

  function syncHeaderControls() {
    queryEl.value = ui.criteria.query || "";
    queryClear.hidden = !queryEl.value;
    document.querySelectorAll("#advanced-text-controls [data-text-mode]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.textMode === ui.criteria.text_mode));
    });
    const whole = document.querySelector("#advanced-text-controls [data-whole-words]");
    whole?.setAttribute("aria-pressed", String(Boolean(ui.criteria.whole_words)));
    sortEl.value = ui.criteria.sort;
    resultViewEl.value = ui.resultView;
    listModelsBtn.setAttribute("aria-pressed", String(ui.listModels));
  }

  function historyLabel(criteria) {
    const q = String(criteria.query || "").trim();
    if (q) return q;
    const parts = [];
    for (const [key, value] of Object.entries(criteria.filters || {})) {
      if (value?.none) parts.push(`No ${key.replaceAll("_", " ")}`);
      else if (value?.include?.length || value?.exclude?.length) parts.push(key.replaceAll("_", " "));
    }
    const statuses = Array.isArray(criteria.statuses) ? criteria.statuses : ["active"];
    if (!(statuses.length === 1 && statuses[0] === "active")) {
      const names = { active: "active", archived: "archived", deleted: "recycle bin" };
      parts.push(statuses.map((value) => names[value] || value).join(" + "));
    }
    if (criteria.pinned_only) parts.push("pinned");
    const dateRange = criteria.date?.range || (criteria.date?.from || criteria.date?.to ? "custom" : "any");
    if (["7", "30", "90"].includes(dateRange)) parts.push(`last ${dateRange} days`);
    if (dateRange === "custom" && criteria.date?.from) parts.push(`from ${criteria.date.from}`);
    if (dateRange === "custom" && criteria.date?.to) parts.push(`to ${criteria.date.to}`);
    for (const value of criteria.must_have || []) parts.push(`has ${value}`);
    return parts.length ? parts.join(", ") : "All conversations";
  }

  function renderHistoryList(container, rows, saved) {
    container.innerHTML = "";
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "advanced-empty-note";
      empty.textContent = saved ? "No saved searches" : "No recent searches";
      container.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "advanced-history-row";
      const text = document.createElement("span");
      text.className = "advanced-history-label";
      text.textContent = saved ? row.name : historyLabel(row.criteria);
      makeKeyboardAction(text, `Use search: ${text.textContent}`);
      item.title = text.textContent;
      item.appendChild(text);
      item.addEventListener("click", () => applyStoredCriteria(row.criteria));
      if (saved) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "advanced-history-delete";
        remove.textContent = "×";
        remove.title = `Delete ${row.name}`;
        remove.setAttribute("aria-label", `Delete ${row.name}`);
        remove.addEventListener("click", async (event) => {
          event.stopPropagation();
          const ok = await openConfirm({
            title: "Delete saved search?",
            text: `"${row.name}" will be removed from Saved Searches.`,
            okLabel: "Delete",
          });
          if (!ok) return;
          const response = await fetch(`/api/advanced-search/saved/${encodeURIComponent(row.id)}`, { method: "DELETE" });
          if (!response.ok) resultsStatus.textContent = "Could not delete the saved search.";
          await loadHistory();
        });
        item.appendChild(remove);
      }
      container.appendChild(item);
    }
  }

  function renderHistory() {
    renderHistoryList(recentList, ui.history.recent || [], false);
    renderHistoryList(savedList, ui.history.saved || [], true);
  }

  async function loadHistory() {
    try {
      const response = await fetch("/api/advanced-search/history");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      ui.history = await response.json();
    } catch (_) {
      ui.history = { recent: [], saved: [] };
    }
    renderHistory();
  }

  async function ensureLoaded(force = false) {
    if (ui.loaded && !force) return;
    const [optionsResponse] = await Promise.all([
      fetch("/api/advanced-search/options"),
      loadHistory(),
    ]);
    if (!optionsResponse.ok) throw new Error(`HTTP ${optionsResponse.status}`);
    ui.options = await optionsResponse.json();
    ui.loaded = true;
  }

  function applyStoredCriteria(criteria) {
    ui.criteria = normalizeCriteria(criteria);
    ui.resultView = ["default", "compact", "detailed"].includes(criteria.result_view)
      ? criteria.result_view
      : "default";
    ui.listModels = Boolean(criteria.list_models);
    ui.editModes = {};
    ui.allStash = {};
    // The previous search's results don't belong to these criteria.
    ui.results = [];
    ui.total = 0;
    ui.hasRun = false;
    ui.lastSearchKey = null;
    ui.browse = null;
    syncHeaderControls();
    renderFilters();
    renderResults();
    queryEl.focus();
  }

  async function openAdvancedSearch() {
    closeSimpleSearch();
    if (!ui.initializedCriteria) {
      ui.criteria = defaultCriteria();
      ui.initializedCriteria = true;
    }
    panel.hidden = false;
    resultsPanel.hidden = false;
    document.body.classList.add("advanced-search-active");
    ui.open = true;
    resultsPanel.dataset.size = ui.resultSize;
    try {
      await ensureLoaded(true);
      renderFilters();
      renderHistory();
      syncHeaderControls();
      renderResults();
    } catch (error) {
      resultsStatus.textContent = `Could not load search options: ${error.message}`;
    }
    queryEl.focus();
  }

  function closeAdvancedSearch() {
    if (!ui.open) return;
    closeResultMenu();
    ui.open = false;
    panel.hidden = true;
    resultsPanel.hidden = true;
    document.body.classList.remove("advanced-search-active");
    document.body.classList.remove("advanced-results-maximized");
  }

  function payload(offset = 0) {
    const value = clone(ui.criteria);
    value.query = queryEl.value.trim();
    value.sort = sortEl.value;
    value.result_view = ui.resultView;
    value.list_models = ui.listModels;
    value.limit = 100;
    value.offset = offset;
    return value;
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  // What decides which conversations match. View settings and paging don't.
  function searchKey(value) {
    const { offset, limit, result_view, list_models, ...rest } = value;
    return stableJson(rest);
  }

  async function runSearch(options = {}) {
    if (ui.busy) {
      // Run it once the current search finishes, so the newest request
      // (a sort change, a second click) is never dropped.
      ui.pendingSearch = () => runSearch(options || {});
      return;
    }
    ui.criteria.query = queryEl.value.trim();
    ui.criteria.sort = sortEl.value;
    const body = payload(0);
    const key = searchKey(body);
    // Load More only appends when the search is unchanged since the list was
    // built. If it changed, the list is replaced with the new search's results.
    const append = options?.append === true && key === ui.lastSearchKey;
    if (append) body.offset = ui.results.length;
    ui.busy = true;
    ui.hasRun = true;
    resultsStatus.textContent = append ? "Loading more…" : "Searching…";
    try {
      const response = await fetch("/api/advanced-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      ui.results = append
        ? ui.results.concat(data.results || [])
        : (data.results || []);
      ui.total = Number(data.total || 0);
      ui.lastSearchKey = key;
      ui.browse = null;
      resultsStatus.textContent = "";
      renderResults();
      if (!append) await loadHistory();
    } catch (error) {
      resultsStatus.textContent = `Search failed: ${error.message}`;
    } finally {
      ui.busy = false;
      const next = ui.pendingSearch;
      ui.pendingSearch = null;
      if (next) next();
    }
  }

  // List every conversation in one location (a folder, Archived or Deleted)
  // in the results area, as the same result cards a search shows.
  async function runBrowse(location, append = false) {
    if (ui.busy) {
      ui.pendingSearch = () => runBrowse(location, append);
      return;
    }
    ui.busy = true;
    ui.hasRun = true;
    resultsStatus.textContent = append ? "Loading more…" : "Loading…";
    try {
      const response = await fetch("/api/advanced-search/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: location.kind,
          id: location.id,
          provider: location.provider,
          sort: sortEl.value,
          limit: 100,
          offset: append ? ui.results.length : 0,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      ui.results = append ? ui.results.concat(data.results || []) : (data.results || []);
      ui.total = Number(data.total || 0);
      ui.lastSearchKey = null;
      ui.browse = location;
      resultsStatus.textContent = "";
      renderResults();
      if (!append) resultsList.scrollTop = 0;
    } catch (error) {
      resultsStatus.textContent = `Could not open ${location.name}: ${error.message}`;
    } finally {
      ui.busy = false;
      const next = ui.pendingSearch;
      ui.pendingSearch = null;
      if (next) next();
    }
  }

  // Where a result lives, shown before its title. Deleted wins over the
  // rest, then Archived, then the folder; null when it is in none of them.
  function resultLocation(result) {
    if (result.deleted) return { kind: "deleted", name: "Deleted", provider: result.provider };
    if (result.archived) return { kind: "archived", name: "Archived", provider: result.provider };
    if (result.folder) {
      return { kind: "folder", id: result.folder.id, name: result.folder.name, provider: result.provider };
    }
    return null;
  }

  // ── Result ⋮ menu ─────────────────────────────────────────────────────────
  let resultMenu = null;

  function closeResultMenu() {
    if (!resultMenu) return;
    restoreActionMenuFocus(resultMenu);
    resultMenu.remove();
    resultMenu = null;
    document.removeEventListener("mousedown", onResultMenuOutside, true);
    window.removeEventListener("scroll", closeResultMenu, true);
  }

  function onResultMenuOutside(event) {
    if (resultMenu && !resultMenu.contains(event.target)) closeResultMenu();
  }

  // Re-draw the cards after an action, keeping the list where it was.
  function refreshResults() {
    const scroll = resultsList.scrollTop;
    renderResults();
    resultsList.scrollTop = scroll;
  }

  // Keep the open conversation's own pin/folder state in step, so the
  // conversation's ⋮ menu acts on what the result menu just changed.
  function syncActiveConversation(result) {
    if (state.activeId !== result.id) return;
    state.activeFolderId = result.folder ? result.folder.id : null;
    state.activeFolderPinned = Boolean(result.folder && result.pinned);
    state.activePinned = Boolean(!result.folder && result.pinned);
  }

  async function addResultToFolder(result) {
    let folders = [];
    try {
      const response = await fetch(`/api/folders?${new URLSearchParams({ provider: result.provider })}`);
      folders = (await response.json()).folders || [];
    } catch (_) {
      resultsStatus.textContent = "Could not load the folders.";
      return;
    }
    const folderId = await openFolderPicker(folders, result.folder?.id);
    // The folder it is already in: nothing to move (moving would clear its
    // pin within the folder).
    if (!folderId || folderId === result.folder?.id) return;
    const data = await apiMoveToFolder(folderId, result.id);
    if (!data || data.error) {
      resultsStatus.textContent = "Could not add the conversation to the folder.";
      return;
    }
    const folder = folders.find((item) => item.id === folderId);
    // Moving into a folder un-archives it and drops its pin.
    result.folder = { id: folderId, name: folder ? folder.name : "" };
    result.archived = false;
    result.pinned = false;
    syncActiveConversation(result);
    refreshResults();
    await afterFolderChange();
  }

  async function togglePinResult(result) {
    const next = !result.pinned;
    if (result.folder) await apiFolderPin(result.id, next);
    else if (next) await apiPinConversation(result.id);
    else await apiUnpinConversation(result.id);
    result.pinned = next;
    syncActiveConversation(result);
    refreshResults();
    await afterFolderChange();
  }

  async function archiveResult(result) {
    await apiUpdateConversationMeta(result.id, { archived: true });
    // Archiving takes a chat out of its folder, and its pin there with it.
    if (result.folder) {
      result.folder = null;
      result.pinned = false;
    }
    result.archived = true;
    syncActiveConversation(result);
    refreshResults();
    await afterFolderChange();
  }

  async function deleteResult(result) {
    const ok = await openConfirm({
      title: "Delete conversation?",
      text: `"${result.title || "Untitled"}" will be moved to the Recycle Bin.`,
      okLabel: "Delete",
    });
    if (!ok) return;
    await apiUpdateConversationMeta(result.id, { deleted: true });
    result.deleted = true;
    refreshResults();
    await afterFolderChange();
  }

  function openResultMenu(result, anchor) {
    const wasForThis = resultMenu && resultMenu.dataset.convId === result.id;
    closeResultMenu();
    if (wasForThis) return; // clicking the same ⋮ again closes it
    const menu = document.createElement("div");
    menu.className = "sidebar-menu conv-item-menu";
    menu.dataset.convId = result.id;
    menu.setAttribute("role", "menu");
    const items = [
      ["Add to Folder", () => addResultToFolder(result)],
      [result.pinned ? "Unpin" : "Pin", () => togglePinResult(result)],
      ["Archive", () => archiveResult(result)],
      ["Delete", () => deleteResult(result)],
    ];
    for (const [label, fn] of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sidebar-menu-item";
      btn.setAttribute("role", "menuitem");
      const text = document.createElement("span");
      text.className = "sidebar-menu-item-label";
      text.textContent = label;
      btn.appendChild(text);
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        closeResultMenu();
        fn();
      });
      menu.appendChild(btn);
    }
    $("workspace-controls").appendChild(menu);
    resultMenu = menu;
    // Under the button, right-aligned, kept on screen.
    const inset = themePixels("--popover-safe-inset");
    const gap = themePixels("--popover-gap");
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(inset, rect.right - menu.offsetWidth);
    let top = rect.bottom + gap;
    if (top + menu.offsetHeight > window.innerHeight - inset) {
      top = rect.top - menu.offsetHeight - gap;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    prepareActionMenu(menu, anchor, closeResultMenu);
    document.addEventListener("mousedown", onResultMenuOutside, true);
    window.addEventListener("scroll", closeResultMenu, true);
  }

  function formatStartDate(value) {
    const number = Number(value || 0);
    if (!number) return "Unknown date";
    return new Date(number * 1000).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });
  }

  function appendDetailChip(container, text) {
    const chip = document.createElement("span");
    chip.className = "advanced-detail-chip";
    chip.textContent = text;
    container.appendChild(chip);
  }

  function renderResults() {
    resultsList.innerHTML = "";
    resultsList.dataset.view = ui.resultView;
    if (ui.browse) {
      resultsCount.textContent = `${ui.browse.name}: ${ui.total.toLocaleString()} Conversation${ui.total === 1 ? "" : "s"}`;
    } else {
      resultsCount.textContent = ui.hasRun
        ? `${ui.total.toLocaleString()} Search Result${ui.total === 1 ? "" : "s"}`
        : "Search Results";
    }
    if (!ui.hasRun) {
      const empty = document.createElement("div");
      empty.className = "advanced-empty-note";
      empty.textContent = "Choose filters, then use the search icon to run the search.";
      resultsList.appendChild(empty);
      syncResultSizeButtons();
      return;
    }
    if (!ui.results.length) {
      const empty = document.createElement("div");
      empty.className = "advanced-empty-note";
      empty.textContent = ui.browse
        ? `No conversations in ${ui.browse.name}.`
        : "No conversations matched these filters.";
      resultsList.appendChild(empty);
      syncResultSizeButtons();
      return;
    }
    const multiProvider = ui.criteria.providers.length > 1;
    for (const result of ui.results) {
      const card = document.createElement("article");
      card.className = "advanced-result-card";
      makeKeyboardAction(card, `Open ${result.title || "Untitled"}`);
      const titleRow = document.createElement("div");
      titleRow.className = "advanced-result-title-row";
      const title = document.createElement("span");
      title.className = "advanced-result-title";
      // Location\chat name. Clicking the location lists everything in it.
      const location = resultLocation(result);
      if (location) {
        const locationBtn = document.createElement("button");
        locationBtn.type = "button";
        locationBtn.className = "advanced-result-location";
        locationBtn.textContent = location.name;
        locationBtn.title = `Open ${location.name}`;
        locationBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          runBrowse(location);
        });
        const sep = document.createElement("span");
        sep.className = "advanced-result-location-sep";
        sep.textContent = "\\";
        title.append(locationBtn, sep);
      }
      title.append(result.title || "Untitled");
      const matches = document.createElement("span");
      matches.className = "advanced-result-matches";
      matches.textContent = `${Number(result.match_count || 0).toLocaleString()} match${Number(result.match_count || 0) === 1 ? "" : "es"}`;
      const date = document.createElement("span");
      date.className = "advanced-result-date";
      date.textContent = formatStartDate(result.create_time);
      const menuBtn = document.createElement("button");
      menuBtn.type = "button";
      menuBtn.className = "conv-menu-btn advanced-result-menu-btn";
      menuBtn.title = "More";
      menuBtn.setAttribute("aria-label", "More");
      menuBtn.setAttribute("aria-haspopup", "menu");
      menuBtn.innerHTML =
        '<svg viewBox="0 0 4 16" width="4" height="16" aria-hidden="true">'
        + '<circle cx="2" cy="2" r="1.7"/><circle cx="2" cy="8" r="1.7"/>'
        + '<circle cx="2" cy="14" r="1.7"/></svg>';
      menuBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openResultMenu(result, menuBtn);
      });
      titleRow.append(title, matches, date, menuBtn);
      if (ui.resultView === "compact" && multiProvider) {
        const provider = document.createElement("span");
        provider.className = "advanced-provider-chip";
        provider.dataset.provider = result.provider;
        provider.textContent = result.provider === "chatgpt" ? "ChatGPT" : "Claude";
        titleRow.insertBefore(provider, date);
      }
      if (ui.resultView === "compact" && ui.listModels) {
        const models = document.createElement("span");
        models.className = "advanced-model-list";
        models.textContent = (result.models || []).join(", ") || "Unidentified";
        titleRow.insertBefore(models, date);
      }
      card.appendChild(titleRow);

      if (result.snippet) {
        const snippet = document.createElement("div");
        snippet.className = "advanced-result-snippet";
        snippet.textContent = result.snippet;
        card.appendChild(snippet);
        const source = document.createElement("div");
        source.className = "advanced-result-source";
        source.textContent = result.snippet_source || "Conversation";
        card.appendChild(source);
      }

      const detail = document.createElement("div");
      detail.className = "advanced-detail-chips";
      for (const value of result.tags || []) appendDetailChip(detail, value);
      for (const value of result.mood_tags || []) appendDetailChip(detail, value);
      for (const value of result.labels || []) {
        const chip = labelChip(value);
        if (String(value.name || "").trim()) chip.title = value.name;
        detail.appendChild(chip);
      }
      if (result.bookmarked) appendDetailChip(detail, "★ Bookmarked");
      card.appendChild(detail);

      if (ui.resultView !== "compact" && (multiProvider || ui.listModels)) {
        const bottom = document.createElement("div");
        bottom.className = "advanced-result-bottom";
        if (multiProvider) {
          const provider = document.createElement("span");
          provider.className = "advanced-provider-chip";
          provider.dataset.provider = result.provider;
          provider.textContent = result.provider === "chatgpt" ? "ChatGPT" : "Claude";
          bottom.appendChild(provider);
        }
        if (ui.listModels) {
          const models = document.createElement("span");
          models.className = "advanced-model-list";
          models.textContent = (result.models || []).join(", ") || "Unidentified";
          bottom.appendChild(models);
        }
        card.appendChild(bottom);
      }
      const open = () => openConversation(result.id, null, result.target_seq);
      card.addEventListener("click", open);
      resultsList.appendChild(card);
    }
    if (ui.results.length < ui.total) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "advanced-load-more";
      more.textContent = `Load More (${ui.results.length.toLocaleString()} of ${ui.total.toLocaleString()})`;
      more.addEventListener("click", () => {
        if (ui.browse) runBrowse(ui.browse, true);
        else runSearch({ append: true });
      });
      resultsList.appendChild(more);
    }
    syncResultSizeButtons();
  }

  function setResultSize(size) {
    ui.resultSize = size;
    resultsPanel.dataset.size = size;
    resultsPanel.style.removeProperty("--advanced-results-height");
    syncResultSizeButtons();
  }

  function syncResultSizeButtons() {
    upBtn.hidden = ui.resultSize === "max";
    downBtn.hidden = ui.resultSize === "min";
    document.body.classList.toggle(
      "advanced-results-maximized",
      ui.open && ui.resultSize === "max",
    );
  }

  function topModalIsOpen() {
    return [...document.querySelectorAll('[role="dialog"]')].some((item) => !item.closest("[hidden]") && item.getClientRects().length);
  }

  function sidebarOverlayIsOpen() {
    return [$("bookmark-panel"), $("notes-side-panel")].some((item) => item && !item.hidden);
  }

  $("manage-search-btn")?.addEventListener("click", openAdvancedSearch);
  $("advanced-close")?.addEventListener("click", closeAdvancedSearch);
  $("advanced-clear-all")?.addEventListener("click", () => {
    ui.criteria = defaultCriteria();
    ui.editModes = {};
    ui.allStash = {};
    ui.results = [];
    ui.total = 0;
    ui.hasRun = false;
    ui.lastSearchKey = null;
    ui.browse = null;
    ui.resultView = "default";
    ui.listModels = false;
    syncHeaderControls();
    renderFilters();
    renderResults();
  });
  $("advanced-save-search")?.addEventListener("click", async () => {
    const name = await openNameModal({ title: "Save Search", value: "", okLabel: "Save" });
    if (!name) return;
    const response = await fetch("/api/advanced-search/saved", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, criteria: payload() }),
    });
    if (response.ok) await loadHistory();
    else resultsStatus.textContent = "Could not save the search.";
  });
  $("advanced-query-submit")?.addEventListener("click", runSearch);
  queryEl.addEventListener("input", () => { queryClear.hidden = !queryEl.value; });
  queryEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch();
    }
  });
  queryClear.addEventListener("click", () => {
    queryEl.value = "";
    ui.criteria.query = "";
    queryClear.hidden = true;
    queryEl.focus();
  });

  document.querySelectorAll("#advanced-text-controls [data-text-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ui.criteria.text_mode = btn.dataset.textMode;
      syncHeaderControls();
    });
  });
  document.querySelector("#advanced-text-controls [data-whole-words]")?.addEventListener("click", () => {
    ui.criteria.whole_words = !ui.criteria.whole_words;
    syncHeaderControls();
  });
  sortEl.addEventListener("change", () => {
    ui.criteria.sort = sortEl.value;
    if (ui.browse) runBrowse(ui.browse);
    else if (ui.hasRun) runSearch();
  });
  resultViewEl.addEventListener("change", () => {
    ui.resultView = resultViewEl.value;
    renderResults();
  });
  listModelsBtn.addEventListener("click", () => {
    ui.listModels = !ui.listModels;
    listModelsBtn.setAttribute("aria-pressed", String(ui.listModels));
    renderResults();
  });
  upBtn.addEventListener("click", () => {
    setResultSize(ui.resultSize === "min" ? "default" : "max");
  });
  downBtn.addEventListener("click", () => {
    setResultSize(ui.resultSize === "max" ? "default" : "min");
  });

  if (resizeHandle) {
    const heightBounds = () => {
      const min = themePixels("--advanced-results-min-h");
      return [min, Math.max(min, $("main").clientHeight - themePixels("--advanced-results-top-clearance"))];
    };
    setupResizeHandle(resizeHandle, {
      label: "Search results height", orientation: "horizontal", controls: "advanced-results-panel", reverse: true,
      getValue: () => resultsPanel.offsetHeight,
      getBounds: heightBounds,
      setValue: (height) => {
        ui.resultSize = "default";
        resultsPanel.dataset.size = "default";
        resultsPanel.style.setProperty("--advanced-results-height", `${height}px`);
        syncResultSizeButtons();
      },
    });
    let dragging = false;
    resizeHandle.addEventListener("mousedown", (event) => {
      if (ui.resultSize === "max") setResultSize("default");
      dragging = true;
      document.body.classList.add("resizing-rows");
      event.preventDefault();
    });
    document.addEventListener("mousemove", (event) => {
      if (!dragging) return;
      const mainRect = $("main").getBoundingClientRect();
      const [min, max] = heightBounds();
      const height = Math.max(min, Math.min(max, mainRect.bottom - event.clientY));
      ui.resultSize = "default";
      resultsPanel.dataset.size = "default";
      resultsPanel.style.setProperty("--advanced-results-height", `${height}px`);
      syncResultSizeButtons();
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing-rows");
    });
  }

  // Capture Escape so advanced mode closes only after dialogs and sidebar
  // overlays have had priority. Their own handlers remain responsible for the
  // first Escape; the next one reaches this mode.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !ui.open) return;
    // Inline naming/tag editors get their own first Escape to cancel edits.
    if (isTextEntryTarget(event.target) && event.target !== queryEl) return;
    if (topModalIsOpen() || sidebarOverlayIsOpen()) return;
    if (resultMenu) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeResultMenu();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAdvancedSearch();
  }, true);

  window.advancedSearchController = {
    open: openAdvancedSearch,
    close: closeAdvancedSearch,
    isOpen: () => ui.open,
  };

  syncResultSizeButtons();
})();
