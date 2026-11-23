export const BRIDGE_SOURCE = String.raw`(() => {
  "use strict";
  // Window is a global interface: matchMedia lives on the instance.
  const matchMedia = window.matchMedia;
  const getComputedStyle = window.getComputedStyle;
  const omitted = new Set(["script", "style", "template", "noscript"]);
  const post = message => window.parent.postMessage(message, "*");
  const ranges = new Map();
  const dom = (prototype, method, receiver, ...args) => prototype[method].call(receiver, ...args);
  const listen = (target, type, handler, options) => dom(window.EventTarget.prototype, "addEventListener", target, type, handler, options);
  const elementCall = (method, element, ...args) => dom(window.Element.prototype, method, element, ...args);
  const rangeCall = (method, range, ...args) => dom(window.Range.prototype, method, range, ...args);
  const createRange = () => dom(window.Document.prototype, "createRange", document);
  const descriptor = (prototype, name) => {
    while (prototype) {
      const found = Object.getOwnPropertyDescriptor(prototype, name);
      if (found) return found;
      prototype = Object.getPrototypeOf(prototype);
    }
  };
  const read = (prototype, name, receiver) => descriptor(prototype, name).get.call(receiver);
  const write = (prototype, name, receiver, value) => descriptor(prototype, name).set.call(receiver, value);
  const documentValue = name => read(window.Document.prototype, name, document);
  const nodeValue = (name, node) => read(window.Node.prototype, name, node);
  const elementValue = (name, element) => read(window.Element.prototype, name, element);
  const nodeType = node => nodeValue("nodeType", node);
  const localName = node => elementValue("localName", node);
  const namespace = node => elementValue("namespaceURI", node);
  const textData = node => read(window.CharacterData.prototype, "data", node);
  const children = node => nodeValue("childNodes", node);
  const body = () => documentValue("body");
  const documentElement = () => documentValue("documentElement");
  const scroller = () => documentValue("scrollingElement") || documentElement();
  // A weak layout fallback: first in the head and in the first cascade layer, so every document-level rule of the doc's own CSS wins.
  try {
    const fallback = dom(window.Document.prototype, "createElement", document, "style");
    write(window.Element.prototype, "textContent", fallback, "@layer emend-fallback { pre { overflow-x: auto; } }");
    const root = documentElement();
    const first = root && elementValue("firstElementChild", root);
    const parent = first && localName(first) === "head" ? first : root;
    dom(window.Node.prototype, "insertBefore", parent, fallback, nodeValue("firstChild", parent));
  } catch { /* The doc renders without the fallback. */ }
  const docs = new Set();
  let headings = [], parts = [];
  // Kept in parity with LIMITS.htmlPartsPerDoc by the bridge tests
  const HTML_PARTS_MAX = 10000;
  const partTags = new Set(["address", "article", "aside", "blockquote", "caption", "dd", "details", "dialog",
    "div", "dt", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hgroup", "legend", "li", "main", "nav", "p", "pre", "section", "summary", "td", "th"]);
  // Kept in parity with htmlHeadings, nodeText and cleanDocTitle by the bridge fixture tests.
  function* nodes(root, limit = Infinity) {
    const pending = [[root][Symbol.iterator]()];
    while (pending.length) {
      const next = pending[pending.length - 1].next();
      if (next.done) { pending.pop(); continue; }
      if (limit-- <= 0) return;
      const node = next.value;
      if (nodeType(node) === 1 && omitted.has(localName(node))) continue;
      yield node;
      if (nodeType(node) === 1) pending.push(children(node)[Symbol.iterator]());
    }
  }
  function label(root, maximum = 200, rawBudget = maximum * 4) {
    let left = rawBudget;
    const parts = [];
    for (const node of nodes(root, rawBudget * 8)) {
      if (nodeType(node) !== 3) continue;
      const part = textData(node).slice(0, left);
      parts.push(part);
      left -= part.length;
      if (!left) break;
    }
    return cleanLabel(parts.join(""), maximum, rawBudget);
  }
  function cleanLabel(text, maximum = 200, rawBudget = maximum * 4) {
    const discarded = [[0,31],[127,159],[847,847],[1564,1564],[4447,4448],[8203,8207],[8234,8238],
      [8288,8303],[12644,12644],[65024,65039],[65279,65279],[65440,65440],[65529,65531],
      [917504,917631],[917760,917999]];
    return Array.from(text.slice(0, rawBudget).replace(/[\s\x85]/gu, " "))
      .filter(char => !discarded.some(([from, to]) => char.codePointAt(0) >= from && char.codePointAt(0) <= to))
      .join("").replace(/ +/g, " ").trim().toWellFormed().slice(0, maximum).replace(/[\uD800-\uDBFF]$/, "").trim();
  }
  function withinNestingLimit() {
    if (!documentElement()) return false;
    const depth = [{ node: documentElement(), level: 1 }];
    const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    while (depth.length) {
      const { node, level } = depth.pop();
      if (nodeType(node) !== 1) continue;
      if (level > 512 && !(namespace(node) === "http://www.w3.org/1999/xhtml" && voids.has(localName(node)))) return false;
      const content = localName(node) === "template" && namespace(node) === "http://www.w3.org/1999/xhtml"
        ? read(window.HTMLTemplateElement.prototype, "content", node) : node;
      for (const child of children(content)) depth.push({ node: child, level: level + 1 });
    }
    return true;
  }
  function collectHeadings() {
    if (!body() || !withinNestingLimit()) return [];
    const found = [];
    for (const node of nodes(body())) {
      if (nodeType(node) !== 1 || namespace(node) !== "http://www.w3.org/1999/xhtml" ||
          (localName(node) !== "h2" && localName(node) !== "h3")) continue;
      found.push({ element: node, label: label(node) });
      if (found.length === 1024) break;
    }
    return found;
  }
  // Kept in parity with htmlPartTexts by the bridge tests.
  function collectParts() {
    if (!body() || !withinNestingLimit()) return [];
    const found = [];
    const pending = [{ nodes: children(body())[Symbol.iterator](), part: undefined }];
    while (pending.length) {
      const entry = pending[pending.length - 1];
      const next = entry.nodes.next();
      if (next.done) { pending.pop(); continue; }
      const node = next.value;
      if (nodeType(node) === 3) {
        // Mirror normalizeText's collapse plus trim: trim also strips U+FEFF; its other chars are White_Space.
        if (entry.part && /[^\p{White_Space}\uFEFF]/u.test(textData(node))) entry.part.nonempty = true;
      } else if (nodeType(node) === 1 && !omitted.has(localName(node))) {
        let part = entry.part;
        if (namespace(node) === "http://www.w3.org/1999/xhtml" && partTags.has(localName(node))) {
          part = { element: node, nonempty: false };
          found.push(part);
        }
        pending.push({ nodes: children(node)[Symbol.iterator](), part });
      }
    }
    return found.filter(part => part.nonempty).slice(0, HTML_PARTS_MAX).map(part => part.element);
  }
  const bounds = element => elementCall("getBoundingClientRect", element);
  const laidOut = element => typeof window.Element.prototype.checkVisibility === "function"
    ? elementCall("checkVisibility", element) : elementCall("getClientRects", element).length > 0;
  const renderedParent = node =>
    (nodeType(node) === 1 ? elementValue("assignedSlot", node) : null) || nodeValue("parentNode", node) ||
    (node instanceof window.ShadowRoot ? read(window.ShadowRoot.prototype, "host", node) : null);
  function reveal(element) {
    for (let node = element; node; node = renderedParent(node)) {
      if (nodeType(node) === 1 && namespace(node) === "http://www.w3.org/1999/xhtml" && localName(node) === "details")
        elementCall("setAttribute", node, "open", "");
    }
  }
  function scroll(element) {
    releasePin();
    reveal(element);
    elementCall("scrollIntoView", element, { block: "start", behavior: "instant" });
  }
  const scrollTo = (top, container = scroller()) => elementCall("scrollTo", container, { top, behavior: "instant" });
  function measure(previous) {
    const line = Math.round(window.innerHeight / 4);
    const bodyElement = body();
    const end = Math.max(elementValue("scrollHeight", documentElement()),
      bodyElement ? elementValue("scrollHeight", bodyElement) : 0) - window.scrollY;
    const sections = [];
    let heading = null, last = null, changed = !previous || previous.end !== end || previous.line !== line;
    // One visibility check and one rect per laid-out heading; no ancestor or style lookup.
    for (let index = 0; index < headings.length; index++) {
      const element = headings[index].element;
      const top = laidOut(element) ? bounds(element).top : null;
      const section = top === null ? null : { top, bottom: end };
      if (section) {
        if (last) last.bottom = top;
        last = section;
        if (top <= line) heading = index;
      }
      if (top !== (previous?.sections[index]?.top ?? null)) changed = true;
      sections.push(section);
    }
    return { sections, heading, end, line, changed };
  }
  const sectionHeight = section => Math.max(1, section.bottom - section.top);
  function position(view) {
    const section = view.sections[view.heading];
    const fraction = section ? Math.max(0, Math.min(1, (view.line - section.top) / sectionHeight(section))) : 0;
    return { heading: view.heading, fraction };
  }
  let positionTimer, previousView, previousPosition, lastPosted, pinnedPosition, landing;
  let remainingSamples = 0;
  let positionRequested = false;
  let scrollSeen = false;
  // The same heading and a fraction within 0.002 is the same position.
  const samePosition = (first, second) => first.heading === second.heading && Math.abs(first.fraction - second.fraction) <= 0.002;
  const releasePin = () => { pinnedPosition = undefined; landing = undefined; };
  function checkPosition() {
    positionTimer = undefined;
    if (!laidOut(documentElement())) { lastPosted = undefined; scrollSeen = false; return; }
    const view = measure(previousView);
    const current = position(view);
    const moved = !previousPosition || !samePosition(current, previousPosition);
    // The pin holds only while the view stays where the goto left it.
    if (pinnedPosition && !samePosition(current, landing)) releasePin();
    // A scroll event restarts the budget only when the position moved since the last sample.
    if (scrollSeen && moved) remainingSamples = 5;
    scrollSeen = false;
    remainingSamples--;
    const report = pinnedPosition || current;
    if (!lastPosted || !samePosition(report, lastPosted)) {
      post({ type: "emend:position", ...report });
      lastPosted = report;
    }
    const follow = positionRequested || view.changed;
    positionRequested = false;
    previousView = view;
    previousPosition = current;
    // Follow momentum, but never let animation alone keep the timer alive.
    if (follow && remainingSamples > 0) positionTimer = window.setTimeout(checkPosition, 200);
  }
  function schedulePosition() {
    positionRequested = true;
    remainingSamples = 5;
    if (positionTimer === undefined) positionTimer = window.setTimeout(checkPosition, 200);
  }
  function onScroll() {
    if (positionTimer !== undefined) { scrollSeen = true; return; }
    if (!laidOut(documentElement())) { lastPosted = undefined; return; }
    // Unchanged positions start nothing, except for the first report after a hidden frame returns.
    if (lastPosted && previousPosition && samePosition(position(measure()), previousPosition)) return;
    scrollSeen = true;
    remainingSamples = 5;
    positionTimer = window.setTimeout(checkPosition, 200);
  }
  function offsetHeading(element, top, distance, path) {
    const start = top;
    const root = scroller();
    const move = (container, target) => {
      const before = elementValue("scrollTop", container);
      scrollTo(target, container);
      const after = bounds(element).top;
      if (after === top) {
        scrollTo(before, container);
      } else {
        const moved = top - after;
        distance -= moved;
        top = after;
        return { container, before, moved };
      }
    };
    // Backtrack along the same scroll path: undo outer movement before inner movement.
    // Otherwise one total distance could name different layouts and invalidate the bracket.
    while (path.length && distance * path.at(-1).moved < 0) {
      const last = path.at(-1);
      const complete = Math.abs(distance) >= Math.abs(last.moved);
      const undo = move(last.container, complete ? last.before : elementValue("scrollTop", last.container) + distance);
      if (!undo) return start - top;
      last.moved += undo.moved;
      if (complete || last.moved === 0) path.pop();
    }
    const forward = container => {
      if (distance === 0) return;
      const step = move(container, elementValue("scrollTop", container) + distance);
      if (step) path.push(step);
    };
    for (let node = renderedParent(element); node; node = renderedParent(node))
      if (nodeType(node) === 1 && node !== root) forward(node);
    forward(root);
    return start - top;
  }
  const fractionOf = (view, index) => (view.line - view.sections[index].top) / sectionHeight(view.sections[index]);
  function goTo(data) {
    if (!Number.isInteger(data.heading) || data.heading < 0 || data.heading >= headings.length ||
        typeof data.label !== "string" || data.label !== headings[data.heading].label ||
        (data.fraction !== undefined && (typeof data.fraction !== "number" ||
          !Number.isFinite(data.fraction) || data.fraction < 0 || data.fraction > 1))) return;
    const element = headings[data.heading].element;
    reveal(element);
    if (!laidOut(documentElement()) || !laidOut(element)) return;
    elementCall("scrollIntoView", element, { block: "start", behavior: "instant" });
    if (data.fraction !== undefined) {
      // Bracket the target in total measured distance from the scrollIntoView landing.
      const path = [];
      let total = 0, previous, lower, upper;
      for (let pass = 0; pass < 16; pass++) {
        const view = measure();
        const current = position(view);
        if (current.heading === data.heading && Math.abs(current.fraction - data.fraction) <= 0.002) break;
        const section = view.sections[data.heading];
        if (!section) break;
        const fraction = fractionOf(view, data.heading);
        const sample = { total, fraction };
        if (fraction < data.fraction) {
          if (!lower || total > lower.total) lower = sample;
        } else if (!upper || total < upper.total) upper = sample;
        let proposal = total + section.top - view.line + data.fraction * sectionHeight(section);
        if (previous) {
          const step = total - previous.total;
          const slope = (fraction - previous.fraction) / step;
          proposal = total + (data.fraction - fraction) / slope;
          if (!upper) proposal = total + 2 * Math.abs(step);
          else if (!lower) {
            if (!(slope > 0) || !Number.isFinite(proposal) || proposal >= upper.total)
              proposal = total - 2 * Math.abs(step);
          } else if (!(slope > 0) || !Number.isFinite(proposal) || proposal <= lower.total || proposal >= upper.total) {
            proposal = (lower.total + upper.total) / 2;
          }
        }
        previous = sample;
        const moved = offsetHeading(element, section.top, proposal - total, path);
        if (!moved) break;
        total += moved;
      }
    }
    pinnedPosition = { heading: data.heading, fraction: data.fraction ?? 0 };
    landing = position(measure());
    schedulePosition();
  }
  // The same segment-by-segment resolver as core; the parent supplies the revision's exact paths.
  function resolve(base, href, known) {
    const control = value => Array.from(value).some(char => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159));
    if (!href || control(href) || href.includes("\\")) return null;
    const hash = href.indexOf("#");
    const raw = hash < 0 ? href : href.slice(0, hash);
    if (raw.startsWith("/") || raw.includes("?") || /%2f|%5c/i.test(href)) return null;
    let parts, fragment;
    try {
      parts = raw.split("/").map(part => decodeURIComponent(part));
      fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
    } catch { return null; }
    if (parts.some(part => control(part) || part.includes("\\") || part.includes(":")) || (fragment !== undefined && control(fragment))) return null;
    if (raw !== "" && (raw.endsWith("/") || parts.at(-1) === "." || parts.at(-1) === "..")) return null;
    const path = raw === "" ? base.split("/") : base.split("/").slice(0, -1);
    if (raw !== "") for (const part of parts) {
      if (part === ".") continue;
      if (part === "") return null;
      if (part === "..") { if (!path.length) return null; path.pop(); }
      else path.push(part);
    }
    const result = path.join("/");
    return known.has(result) ? { path: result, fragment: fragment || "" } : null;
  }
  let highlightStyle = false;

  // Map normalized UTF-16 offsets back to body text nodes without modifying the DOM.
  function model() {
    const nodes = [];
    const parts = [];
    let length = 0;
    const pending = body() ? [body()] : [];
    while (pending.length) {
      const node = pending.pop();
      if (nodeType(node) === 3) {
        nodes.push({ node, start: length, end: length + textData(node).length });
        parts.push(textData(node));
        length += textData(node).length;
      } else if (nodeType(node) === 1 && !omitted.has(localName(node).toLowerCase())) {
        for (let i = children(node).length - 1; i >= 0; i--) pending.push(children(node)[i]);
      }
    }
    const raw = parts.join("");
    const chunks = [];
    const texts = [];
    let size = 0;
    function add(value, start, end) {
      chunks.push({ start: size, end: size + value.length, rawStart: start, rawEnd: end,
        identity: raw.slice(start, end) === value });
      texts.push(value);
      size += value.length;
    }
    for (const match of raw.matchAll(/\p{White_Space}+|[^\p{White_Space}]+/gu)) {
      const value = match[0];
      if (/^\p{White_Space}/u.test(value)) add(" ", match.index, match.index + value.length);
      else if (value === value.normalize("NFC")) add(value, match.index, match.index + value.length);
      else {
        for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
          const start = match.index + part.index;
          add(part.segment.normalize("NFC"), start, start + part.segment.length);
        }
      }
    }
    const joined = texts.join("");
    const trim = joined.length - joined.trimStart().length;
    const text = joined.trim();
    function normalizedOffset(rawOffset, end) {
      for (const chunk of chunks) {
        if (rawOffset <= chunk.rawStart) return Math.max(0, Math.min(text.length, chunk.start - trim));
        if (rawOffset < chunk.rawEnd) {
          const offset = chunk.identity ? chunk.start + rawOffset - chunk.rawStart : end ? chunk.end : chunk.start;
          return Math.max(0, Math.min(text.length, offset - trim));
        }
      }
      return text.length;
    }
    function rawOffset(offset, end) {
      offset += trim;
      for (const chunk of chunks) {
        if (offset < chunk.end || (end && offset === chunk.end))
          return chunk.identity ? chunk.rawStart + offset - chunk.start : end ? chunk.rawEnd : chunk.rawStart;
      }
      return raw.length;
    }
    function point(offset, end) {
      for (const entry of nodes) {
        if (offset < entry.end || (end && offset === entry.end)) return [entry.node, Math.max(0, offset - entry.start)];
      }
      const last = nodes[nodes.length - 1];
      return last ? [last.node, textData(last.node).length] : null;
    }
    function range(start, end) {
      const first = point(rawOffset(start, false), false);
      const last = point(rawOffset(end, true), true);
      if (!first || !last) return null;
      const result = createRange();
      rangeCall("setStart", result, ...first); rangeCall("setEnd", result, ...last);
      return result;
    }
    function boundary(container, offset, end) {
      const direct = nodes.find(entry => entry.node === container);
      if (direct) return normalizedOffset(direct.start + offset, end);
      const before = createRange();
      rangeCall("selectNodeContents", before, body());
      rangeCall("setEnd", before, container, offset);
      let position = 0;
      for (const entry of nodes) {
        if (rangeCall("comparePoint", before, entry.node, textData(entry.node).length) > 0) break;
        position = entry.end;
      }
      return normalizedOffset(position, end);
    }
    return { text, range, boundary };
  }
  function capture(event) {
    // The glossary card is emend's own: events and selections inside it never become comment anchors.
    if (card && event && dom(window.Event.prototype, "composedPath", event).includes(card.host)) return;
    const selection = dom(window.Document.prototype, "getSelection", document);
    if (!selection || read(window.Selection.prototype, "isCollapsed", selection) || read(window.Selection.prototype, "rangeCount", selection) !== 1 || !body()) return;
    const range = dom(window.Selection.prototype, "getRangeAt", selection, 0);
    const inCard = node => card && (node === card.host || dom(window.Node.prototype, "contains", card.host, node) ||
      dom(window.Node.prototype, "contains", card.dialog, node));
    if (inCard(read(window.Range.prototype, "startContainer", range)) || inCard(read(window.Range.prototype, "endContainer", range)) ||
        inCard(read(window.Selection.prototype, "focusNode", selection))) return;
    if (!dom(window.Node.prototype, "contains", body(), read(window.Range.prototype, "startContainer", range)) || !dom(window.Node.prototype, "contains", body(), read(window.Range.prototype, "endContainer", range))) return;
    const value = model();
    let start = value.boundary(read(window.Range.prototype, "startContainer", range), read(window.Range.prototype, "startOffset", range), false);
    let end = value.boundary(read(window.Range.prototype, "endContainer", range), read(window.Range.prototype, "endOffset", range), true);
    const selected = value.text.slice(start, end);
    start += selected.length - selected.trimStart().length;
    end -= selected.length - selected.trimEnd().length;
    const quote = value.text.slice(start, end);
    if (!quote || quote.length > 2000) return;
    post({ type: "emend:anchor", quote, prefix: value.text.slice(Math.max(0, start - 32), start), suffix: value.text.slice(end, end + 32) });
  }
  let lastAnchors;
  function highlight(anchors) {
    lastAnchors = anchors;
    ranges.clear();
    const supported = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
    if (supported) dom(window.HighlightRegistry.prototype, "delete", CSS.highlights, "emend-quotes");
    const value = model();
    for (const anchor of anchors) {
      if (!anchor || typeof anchor.threadId !== "string" || typeof anchor.quote !== "string" || !anchor.quote || anchor.quote.length > 2000 ||
        typeof anchor.prefix !== "string" || anchor.prefix.length > 32 || typeof anchor.suffix !== "string" || anchor.suffix.length > 32) continue;
      const pattern = anchor.prefix + anchor.quote + anchor.suffix;
      const found = value.text.indexOf(pattern);
      if (found < 0 || value.text.indexOf(pattern, found + 1) >= 0) continue;
      const start = found + anchor.prefix.length;
      const range = value.range(start, start + anchor.quote.length);
      if (!range) continue;
      ranges.set(anchor.threadId, range);
    }
    if (supported && ranges.size) {
      if (!highlightStyle && typeof CSSStyleSheet !== "undefined" && descriptor(window.Document.prototype, "adoptedStyleSheets")) {
        try {
          const sheet = new CSSStyleSheet();
          dom(window.CSSStyleSheet.prototype, "replaceSync", sheet, "::highlight(emend-quotes) { background-color: #fde68a; color: #171717; }");
          write(window.Document.prototype, "adoptedStyleSheets", document, [...documentValue("adoptedStyleSheets"), sheet]);
          highlightStyle = true;
        } catch { /* Highlight support never requires a DOM fallback. */ }
      }
      dom(window.HighlightRegistry.prototype, "set", CSS.highlights, "emend-quotes", new Highlight(...ranges.values()));
    }
    const changed = diagrams.filter(diagram => diagram.host && diagramSourceShown(diagram) !== diagram.sourceShown);
    if (changed.length) holdPosition(() => {
      for (const diagram of changed) updateDiagramSource(diagram);
    });
  }
  // Shared by layout and diagram placement: keep only a live pin or a scrolled reading path.
  function holdPosition(change, changed = true) {
    const root = documentElement();
    let held;
    if (changed && root && headings.length && laidOut(root)) {
      const current = position(measure());
      if (pinnedPosition && samePosition(current, landing)) held = pinnedPosition;
      else if (current.heading !== null) {
        for (let node = headings[current.heading].element; node; node = renderedParent(node)) {
          if (nodeType(node) === 1 && elementValue("scrollTop", node) !== 0) { held = current; break; }
          if (node === root) break;
        }
      }
    }
    change();
    if (held && held.heading !== null) goTo({ ...held, label: headings[held.heading].label });
    schedulePosition();
  }
  // Kept in parity with frame-messages.ts by the diagram bridge tests.
  const DIAGRAM_SOURCE_MAX = 50000;
  const DIAGRAM_COUNT_MAX = 50;
  const DIAGRAM_TOTAL_MAX = 1000000;
  const DIAGRAM_SVG_MAX = 4000000;
  const DIAGRAM_DIMENSION_MAX = 10000;
  const DIAGRAM_REQUEST_MAX = 2147483647;
  let diagrams = [], diagramRequest = 0;
  const styleOf = element => read(window.HTMLElement.prototype, "style", element);
  const styleCall = (method, style, ...args) => dom(window.CSSStyleDeclaration.prototype, method, style, ...args);
  const createElement = name => dom(window.Document.prototype, "createElement", document, name);
  const issueLinks = new WeakMap();
  let repoLinked = false;
  function linkIssues(data) {
    if (repoLinked || Object.keys(data).length !== 2 || typeof data.url !== "string") return;
    // Kept in parity with RepoUrl (packages/contract/src/links.ts) by the bridge tests.
    if (data.url.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(data.url) || !/^https:\/\//i.test(data.url)) return;
    try {
      const url = new window.URL(data.url);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash ||
          url.host !== url.host.toLowerCase()) return;
      const [authority = "", ...path] = data.url.slice("https://".length).split("/");
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/.test(authority) || path.length !== 2 ||
          !path.every(part => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..") ||
          url.pathname !== "/" + path.join("/")) return;
    } catch { return; }
    repoLinked = true;
    const skipped = new Set([...omitted, "a", "code", "pre", "kbd", "samp", "textarea", "title", "button", "select", "option"]);
    const textNodes = [];
    const pending = body() ? [[body()][Symbol.iterator]()] : [];
    let visits = 100000, links = 0;
    // Collect before replacing: childNodes is live, so mutations must not revisit new text nodes.
    while (pending.length && visits) {
      const next = pending[pending.length - 1].next();
      if (next.done) { pending.pop(); continue; }
      visits--;
      const node = next.value;
      if (nodeType(node) === 3) textNodes.push(node);
      else if (nodeType(node) === 1 && namespace(node) === "http://www.w3.org/1999/xhtml" && !skipped.has(localName(node)))
        pending.push(children(node)[Symbol.iterator]());
    }
    for (const node of textNodes) {
      if (links === 10000) break;
      const value = textData(node);
      let fragment, offset = 0;
      // Kept in parity with linkIssueRefs (packages/core/src/render/issue-refs.ts) by the bridge tests.
      for (const match of value.matchAll(/(?<![\w&/#])#([1-9]\d{0,6})(?!\w)/g)) {
        if (!fragment) fragment = dom(window.Document.prototype, "createDocumentFragment", document);
        if (match.index > offset) dom(window.Node.prototype, "appendChild", fragment,
          dom(window.Document.prototype, "createTextNode", document, value.slice(offset, match.index)));
        const link = createElement("a");
        elementCall("setAttribute", link, "href", new window.URL(data.url + "/issues/" + match[1]).href);
        elementCall("setAttribute", link, "rel", "noopener noreferrer nofollow");
        elementCall("setAttribute", link, "target", "_blank");
        dom(window.Node.prototype, "appendChild", link,
          dom(window.Document.prototype, "createTextNode", document, match[0]));
        dom(window.Node.prototype, "appendChild", fragment, link);
        issueLinks.set(link, Number(match[1]));
        offset = match.index + match[0].length;
        if (++links === 10000) break;
      }
      if (!fragment) continue;
      if (offset < value.length) dom(window.Node.prototype, "appendChild", fragment,
        dom(window.Document.prototype, "createTextNode", document, value.slice(offset)));
      dom(window.Node.prototype, "replaceChild", nodeValue("parentNode", node), fragment, node);
    }
    if (lastAnchors) highlight(lastAnchors);
  }
  // The glossary of an HTML doc: the first dl after a heading named Glossary. It is read, marked and drawn
  // inside the frame; nothing about it crosses to the parent.
  // Kept in parity with LIMITS (glossary*) and core's DOC_TERM_MATCH_STEP_BUDGET by the bridge glossary tests.
  const GLOSSARY_TERMS_MAX = 50;
  const GLOSSARY_ALIASES_MAX = 8;
  const GLOSSARY_FORM_MAX = 100;
  const GLOSSARY_DEFINITION_MAX = 2000;
  const GLOSSARY_VISITS_MAX = 100000;
  const GLOSSARY_STEP_MAX = 10000000;
  const htmlElement = node => nodeType(node) === 1 && namespace(node) === "http://www.w3.org/1999/xhtml";
  const createText = text => dom(window.Document.prototype, "createTextNode", document, text);
  const phrasingTags = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "i", "ins",
    "kbd", "mark", "q", "rp", "rt", "ruby", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time",
    "tt", "u", "var"]);
  let glossary = [], glossaryList;
  const termMarks = new WeakMap();
  // Kept in parity with normalizeGlossaryForm and GlossaryForm (packages/contract/src/manifest.ts).
  const glossaryForm = text => text.normalize("NFC").replace(/\s+/gu, " ").trim();
  const validForm = text => text.length > 0 && text.length <= GLOSSARY_FORM_MAX && text.isWellFormed() &&
    !Array.from(text).some(char => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
    });
  // Kept in parity with limitDefinition (packages/core/src/render/glossary-definition.ts).
  function limitDefinition(text) {
    if (text.length <= GLOSSARY_DEFINITION_MAX) return text;
    let cut = GLOSSARY_DEFINITION_MAX - 1;
    if ((text.codePointAt(cut - 1) ?? 0) > 0xffff) cut--;
    return text.slice(0, cut) + "…";
  }
  // Text of an element with a space around block elements, so neighbouring paragraphs do not run together.
  function glossaryText(root) {
    const parts = [];
    const pending = [{ nodes: children(root)[Symbol.iterator](), block: false }];
    let left = 20000, visits = 20000;
    while (pending.length && left > 0 && visits > 0) {
      const entry = pending[pending.length - 1];
      const next = entry.nodes.next();
      if (next.done) { pending.pop(); if (entry.block) parts.push(" "); continue; }
      visits--;
      const node = next.value;
      if (nodeType(node) === 3) {
        const part = textData(node).slice(0, left);
        parts.push(part);
        left -= part.length;
      } else if (nodeType(node) === 1 && !omitted.has(localName(node))) {
        const block = !(htmlElement(node) && phrasingTags.has(localName(node)));
        if (block) parts.push(" ");
        pending.push({ nodes: children(node)[Symbol.iterator](), block });
      }
    }
    return parts.join("");
  }
  function readGlossary() {
    glossary = [];
    glossaryList = undefined;
    if (!body()) return;
    let heading, list, headingCount = 0;
    for (const node of nodes(body(), GLOSSARY_VISITS_MAX)) {
      if (!htmlElement(node)) continue;
      const name = localName(node);
      if (!heading) {
        if (/^h[1-6]$/.test(name)) {
          if (++headingCount > 1024) return;
          // Only "glossary" has to match, so a short label is enough. The raw budget leaves room for
          // whitespace and icons before the word; the heading cap bounds the cost.
          if (label(node, 16, 800).toLowerCase() === "glossary") heading = node;
        }
      } else if (name === "dl" && !dom(window.Node.prototype, "contains", heading, node)) { list = node; break; }
    }
    if (!list) return;
    // A dl holds dt and dd children, or div groups of them.
    const items = [];
    for (const child of children(list)) {
      if (!htmlElement(child)) continue;
      const name = localName(child);
      if (name === "dt" || name === "dd") items.push(child);
      else if (name === "div") {
        for (const inner of children(child)) {
          if (items.length >= 10000) break;
          if (htmlElement(inner) && (localName(inner) === "dt" || localName(inner) === "dd")) items.push(inner);
        }
      }
      if (items.length >= 10000) break;
    }
    const seen = new Set();
    const key = form => form.toLowerCase();
    let run;
    const finish = () => {
      const current = run;
      run = undefined;
      if (!current || !current.dds.length || glossary.length >= GLOSSARY_TERMS_MAX) return;
      const term = glossaryForm(glossaryText(current.dts[0]));
      const definition = limitDefinition(glossaryForm(current.dds.map(dd => glossaryText(dd)).join(" ")));
      if (definition === "" || !validForm(term) || seen.has(key(term))) return;
      seen.add(key(term));
      const aliases = [];
      for (const dt of current.dts.slice(1)) {
        if (aliases.length >= GLOSSARY_ALIASES_MAX) break;
        const alias = glossaryForm(glossaryText(dt));
        if (!validForm(alias) || seen.has(key(alias))) continue;
        seen.add(key(alias));
        aliases.push(alias);
      }
      glossary.push({ term, aliases, definition, dt: current.dts[0] });
    };
    for (const item of items) {
      if (localName(item) === "dt") {
        if (run && run.dds.length) finish();
        if (!run) run = { dts: [], dds: [] };
        run.dts.push(item);
      } else if (run) run.dds.push(item);
    }
    finish();
    if (glossary.length) glossaryList = list;
  }
  // Ported from docTermMatcher, scanDocTerms and markTerms (packages/core/src/render/doc-terms.ts and
  // terms.ts), on one text node at a time. The marks may differ from core's: a text node that is not NFC gets
  // none, and a word boundary is not checked across inline elements. The bridge tests hold the
  // single-text-node cases in parity with core's doc matcher, which the regex matcher of the writeup (the
  // reference) agrees with.
  // The forms live in a prefix tree keyed by a case fold, so a position costs at most the depth of the tree
  // and nothing is compiled. Every step is counted: one per code point compared, per whitespace character a
  // space consumes, per start position tried, per form that ends on the way and per code point of an
  // acronym's exact check. Measured here: 10,000,000 steps take 0.1 to 0.3 s of matching, at 1 to 2.5 steps
  // per character of ordinary prose. Finding the grapheme boundaries of a text node that holds a match costs
  // about 0.4 microseconds per character and is not counted.
  // Kept in parity with foldCodePoint (packages/core/src/render/doc-terms.ts) by the bridge glossary tests.
  const foldExceptions = new Map([[0x131, 0x131], [0x1fd3, 0x390], [0x1fe3, 0x3b0], [0xfb05, 0xfb06]]);
  const oneCodePoint = text => {
    const code = text.codePointAt(0) ?? 0;
    return text.length === (code > 0xffff ? 2 : 1) ? code : undefined;
  };
  function foldCodePoint(code) {
    const exception = foldExceptions.get(code);
    if (exception !== undefined) return exception;
    const text = String.fromCodePoint(code);
    const upper = oneCodePoint(text.toUpperCase());
    if (upper !== undefined) {
      const lower = oneCodePoint(String.fromCodePoint(upper).toLowerCase());
      if (lower !== undefined) return lower;
    }
    return oneCodePoint(text.toLowerCase()) ?? code;
  }
  const isSpaceUnit = unit => unit === 32 || (unit >= 9 && unit <= 13) || unit === 0xa0 || unit === 0x1680 ||
    (unit >= 0x2000 && unit <= 0x200a) || unit === 0x2028 || unit === 0x2029 || unit === 0x202f ||
    unit === 0x205f || unit === 0x3000 || unit === 0xfeff;
  const wordPattern = /^[\p{L}\p{M}\p{N}_]$/u;
  function termMatcher(entries) {
    const folds = new Map(), words = new Map();
    const fold = code => {
      let folded = folds.get(code);
      if (folded === undefined) folds.set(code, folded = foldCodePoint(code));
      return folded;
    };
    const word = code => {
      let is = words.get(code);
      if (is === undefined) words.set(code, is = wordPattern.test(String.fromCodePoint(code)));
      return is;
    };
    const forms = entries
      .flatMap((entry, index) => [entry.term, ...entry.aliases].map(form => ({ form: glossaryForm(form), entry: index })))
      .filter(({ form }) => form.length > 0)
      .sort((a, b) => b.form.length - a.form.length)
      .map(({ form, entry }, rank) => ({ entry, rank, codes: Array.from(form, char => char.codePointAt(0) ?? 0),
        acronym: !/\p{Ll}/u.test(form) && (form.match(/\p{Lu}/gu)?.length ?? 0) >= 2 }));
    const root = { next: new Map() };
    for (const form of forms) {
      let node = root;
      for (const code of form.codes) {
        if (code === 32) node = node.space ??= { next: new Map() };
        else {
          const key = fold(code);
          let child = node.next.get(key);
          if (!child) node.next.set(key, child = { next: new Map() });
          node = child;
        }
      }
      (node.forms ??= []).push(form);
    }
    return { forms, root, fold, word, remaining: GLOSSARY_STEP_MAX };
  }
  // Marks the first use of each entry in value. accept(index, length) is the grapheme check of a range;
  // mark(entry, index, length) returns true when no entry is left. Returns false when a step did not fit.
  function scanTerms(matcher, value, accept, seen, mark) {
    const { root, fold, word } = matcher;
    const size = value.length;
    const foldE = fold(101), foldS = fold(115);
    let left = matcher.remaining;
    const wordBefore = index => {
      if (index <= 0) return false;
      let code = value.charCodeAt(index - 1);
      if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
        const high = value.charCodeAt(index - 2);
        if (high >= 0xd800 && high <= 0xdbff) code = (high - 0xd800) * 0x400 + (code - 0xdc00) + 0x10000;
      }
      return word(code);
    };
    const wordAt = index => index < size && word(value.codePointAt(index) ?? 0);
    const exactEnd = (form, start) => {
      let index = start;
      for (const code of form.codes) {
        if (index >= size) return -1;
        if (code === 32) {
          if (!isSpaceUnit(value.charCodeAt(index))) return -1;
          do { index++; left--; } while (index < size && isSpaceUnit(value.charCodeAt(index)) && left >= 0);
        } else {
          left--;
          const here = value.codePointAt(index) ?? 0;
          if (here !== code) return -1;
          index += here > 0xffff ? 2 : 1;
        }
        if (left < 0) return -1;
      }
      return index;
    };
    const withSuffix = (end, exact) => {
      if (end < size) {
        left--;
        const first = value.codePointAt(end) ?? 0;
        if ((exact ? first === 101 : fold(first) === foldE) && end + 1 < size) {
          left--;
          const second = value.codePointAt(end + 1) ?? 0;
          if ((exact ? second === 115 : fold(second) === foldS) && !wordAt(end + 2)) return end + 2;
        }
        if ((exact ? first === 115 : fold(first) === foldS) && !wordAt(end + 1)) return end + 1;
      }
      return wordAt(end) ? -1 : end;
    };
    const find = start => {
      let node = root, index = start, ends;
      while (index < size) {
        const unit = value.charCodeAt(index);
        if (isSpaceUnit(unit)) {
          left--;
          if (!node.space) break;
          do { index++; left--; } while (index < size && isSpaceUnit(value.charCodeAt(index)) && left >= 0);
          node = node.space;
        } else {
          const code = value.codePointAt(index) ?? 0;
          left--;
          const child = node.next.get(fold(code));
          if (!child) break;
          node = child;
          index += code > 0xffff ? 2 : 1;
        }
        if (left < 0) return;
        if (node.forms) {
          left -= node.forms.length;
          ends ??= [];
          for (const form of node.forms) ends.push({ form, end: index });
        }
      }
      if (left < 0 || !ends) return;
      if (ends.length > 1) ends.sort((a, b) => a.form.rank - b.form.rank);
      for (const { form, end } of ends) {
        let literal = end;
        if (form.acronym) {
          literal = exactEnd(form, start);
          if (left < 0) return;
          if (literal < 0) continue;
        }
        const finish = withSuffix(literal, form.acronym);
        if (left < 0) return;
        if (finish < 0) continue;
        if (accept(start, finish - start)) return { entry: form.entry, length: finish - start };
      }
    };
    let index = 0, previousWord = false;
    while (index < size) {
      left--;
      if (left < 0) break;
      const code = value.codePointAt(index) ?? 0;
      if (!previousWord) {
        const hit = find(index);
        if (left < 0) break;
        if (hit) {
          const start = index;
          index += hit.length;
          previousWord = wordBefore(index);
          if (!seen.has(hit.entry) && mark(hit.entry, start, hit.length)) break;
          continue;
        }
      }
      previousWord = word(code);
      index += code > 0xffff ? 2 : 1;
    }
    matcher.remaining = left >= 0 ? left : 0;
    return left >= 0;
  }
  function termMark(text, index) {
    const mark = createElement("span");
    const style = styleOf(mark);
    styleCall("setProperty", style, "text-decoration", "underline dotted");
    styleCall("setProperty", style, "text-underline-offset", "0.15em");
    styleCall("setProperty", style, "cursor", "help");
    for (const [name, value] of [["tabindex", "0"], ["role", "button"], ["aria-haspopup", "dialog"], ["aria-expanded", "false"]])
      elementCall("setAttribute", mark, name, value);
    dom(window.Node.prototype, "appendChild", mark, createText(text));
    termMarks.set(mark, index);
    return mark;
  }
  function markTerms() {
    if (!glossary.length) return;
    const matcher = termMatcher(glossary);
    if (!matcher.forms.length) return;
    const skipped = new Set([...omitted, "a", "code", "pre", "kbd", "samp", "h1", "h2", "h3", "h4", "h5", "h6",
      "textarea", "title", "button", "select", "option"]);
    const textNodes = [];
    const pending = body() ? [[body()][Symbol.iterator]()] : [];
    let visits = GLOSSARY_VISITS_MAX;
    // Collect before replacing: childNodes is live, so mutations must not revisit new text nodes.
    while (pending.length && visits) {
      const next = pending[pending.length - 1].next();
      if (next.done) { pending.pop(); continue; }
      visits--;
      const node = next.value;
      if (nodeType(node) === 3) textNodes.push(node);
      else if (htmlElement(node) && !skipped.has(localName(node)) && node !== glossaryList)
        pending.push(children(node)[Symbol.iterator]());
    }
    const seen = new Set();
    let segmenter;
    for (const node of textNodes) {
      if (seen.size === glossary.length) break;
      const value = textData(node);
      const parent = nodeValue("parentNode", node);
      if (!parent || value !== value.normalize("NFC")) continue;
      // Grapheme boundaries are found only once a form matches in this text node.
      let boundaries;
      const accept = (start, length) => {
        if (!boundaries) {
          segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
          boundaries = new Set([value.length]);
          for (const { index } of segmenter.segment(value)) boundaries.add(index);
        }
        return boundaries.has(start) && boundaries.has(start + length);
      };
      const replacements = [];
      let end = 0;
      const scanned = scanTerms(matcher, value, accept, seen, (entry, start, length) => {
        if (start > end) replacements.push(createText(value.slice(end, start)));
        replacements.push(termMark(value.slice(start, start + length), entry));
        end = start + length;
        seen.add(entry);
        return seen.size === glossary.length;
      });
      if (!scanned) break;
      if (!replacements.length) continue;
      if (end < value.length) replacements.push(createText(value.slice(end)));
      const fragment = dom(window.Document.prototype, "createDocumentFragment", document);
      for (const part of replacements) dom(window.Node.prototype, "appendChild", fragment, part);
      dom(window.Node.prototype, "replaceChild", parent, fragment, node);
    }
  }
  // The card: text only, in a closed shadow root on a host the doc's markup cannot reach.
  let card, openTerm, hoverTimer, leaveTimer, pointerTarget = null, restoringFocus = false;
  const markFor = node => {
    for (let current = node; current; current = nodeValue("parentNode", current)) if (termMarks.has(current)) return current;
    return null;
  };
  const isNode = value => value instanceof window.Node;
  const insideCard = target => !!card && isNode(target) &&
    (target === card.host || dom(window.Node.prototype, "contains", card.host, target) ||
      dom(window.Node.prototype, "contains", card.dialog, target));
  const insideOpen = target => !!openTerm && isNode(target) &&
    (dom(window.Node.prototype, "contains", openTerm.mark, target) || insideCard(target));
  const activeElement = () => documentValue("activeElement");
  const focusedOpen = (target = activeElement()) => insideOpen(target);
  const cardFocused = () => !!card && activeElement() === card.host;
  const hoveredOpen = () => !!pointerTarget && nodeValue("isConnected", pointerTarget) && insideOpen(pointerTarget);
  const clearOpenTimer = () => { window.clearTimeout(hoverTimer); hoverTimer = undefined; };
  const clearCloseTimer = () => { window.clearTimeout(leaveTimer); leaveTimer = undefined; };
  const focusElement = (element, options) => dom(window.HTMLElement.prototype, "focus", element, options);
  const eventTarget = event => read(window.Event.prototype, "target", event);
  const pointerKind = event => event.pointerType === "mouse" || event.pointerType === "pen";
  function ensureCard() {
    if (card) return card;
    const host = createElement("emend-term-card");
    const hostStyle = styleOf(host);
    for (const [name, value] of [["position", "fixed"], ["left", "0"], ["top", "0"], ["width", "0"], ["height", "0"],
        ["margin", "0"], ["padding", "0"], ["border", "0"], ["display", "none"], ["z-index", "2147483647"]])
      styleCall("setProperty", hostStyle, name, value, "important");
    const shadow = elementCall("attachShadow", host, { mode: "closed" });
    // The theme's variables where the frame defines them, the frame's own colour scheme otherwise.
    const css = ".card{position:fixed;left:0;top:0;box-sizing:border-box;width:min(20rem,calc(100vw - 16px));" +
      "max-height:calc(100vh - 16px);overflow:auto;margin:0;padding:12px;background:var(--bg-raised,Canvas);" +
      "color:var(--fg-1,CanvasText);border:1px solid var(--border-1,GrayText);border-radius:8px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.25);font:400 14px/1.5 var(--font-sans,system-ui,sans-serif);" +
      "text-align:start;text-transform:none;letter-spacing:normal;text-indent:0;white-space:normal;overflow-wrap:anywhere}" +
      "p{margin:6px 0}strong{font-weight:600}" +
      "button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;text-decoration:underline;cursor:pointer}" +
      "button:focus-visible{outline:2px solid currentColor;outline-offset:2px}";
    try {
      const sheet = new CSSStyleSheet();
      dom(window.CSSStyleSheet.prototype, "replaceSync", sheet, css);
      write(window.ShadowRoot.prototype, "adoptedStyleSheets", shadow, [sheet]);
    } catch { /* The card stays usable, only plain, without constructed stylesheet support. */ }
    const dialog = createElement("div");
    elementCall("setAttribute", dialog, "class", "card");
    elementCall("setAttribute", dialog, "role", "dialog");
    elementCall("setAttribute", dialog, "aria-labelledby", "term");
    const term = createElement("strong");
    elementCall("setAttribute", term, "id", "term");
    const definition = createElement("p");
    const control = createElement("button");
    elementCall("setAttribute", control, "type", "button");
    write(window.Element.prototype, "textContent", control, "Glossary");
    for (const element of [term, definition, control]) elementCall("setAttribute", element, "dir", "auto");
    for (const element of [term, definition, control]) dom(window.Node.prototype, "appendChild", dialog, element);
    dom(window.Node.prototype, "appendChild", shadow, dialog);
    dom(window.Node.prototype, "appendChild", body(), host);
    listen(control, "click", () => {
      const entry = openTerm && glossary[openTerm.index];
      if (!entry) return;
      if (nodeValue("isConnected", entry.dt)) { scroll(entry.dt); schedulePosition(); }
      closeCard();
    });
    return card = { host, dialog, term, definition, control };
  }
  function positionCard() {
    if (!openTerm || !card) return;
    const anchor = bounds(openTerm.mark);
    const size = bounds(card.dialog);
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - size.width - 8));
    const below = anchor.bottom + 6;
    const top = below + size.height <= window.innerHeight - 8 ? below : anchor.top - size.height - 6;
    const style = styleOf(card.dialog);
    styleCall("setProperty", style, "left", left + "px");
    styleCall("setProperty", style, "top", Math.max(8, Math.min(top, window.innerHeight - size.height - 8)) + "px");
  }
  function showCard(mark, focus = false) {
    const index = termMarks.get(mark);
    const entry = glossary[index];
    if (!entry || !nodeValue("isConnected", mark)) return;
    clearOpenTimer();
    clearCloseTimer();
    if (openTerm && openTerm.mark !== mark) elementCall("setAttribute", openTerm.mark, "aria-expanded", "false");
    const view = ensureCard();
    write(window.Element.prototype, "textContent", view.term, entry.term);
    write(window.Element.prototype, "textContent", view.definition, entry.definition);
    openTerm = { mark, index };
    elementCall("setAttribute", mark, "aria-expanded", "true");
    styleCall("setProperty", styleOf(view.host), "display", "block", "important");
    positionCard();
    if (focus) focusElement(view.control);
  }
  function closeCard(restore = false) {
    clearOpenTimer();
    clearCloseTimer();
    const current = openTerm;
    openTerm = undefined;
    if (!current || !card) return;
    elementCall("setAttribute", current.mark, "aria-expanded", "false");
    styleCall("setProperty", styleOf(card.host), "display", "none", "important");
    if (restore && nodeValue("isConnected", current.mark)) {
      restoringFocus = true;
      try { focusElement(current.mark); } finally { restoringFocus = false; }
    }
  }
  function delayOpen(mark) {
    clearOpenTimer();
    if (openTerm && openTerm.mark === mark) return;
    hoverTimer = window.setTimeout(() => { hoverTimer = undefined; showCard(mark); }, 500);
  }
  // Behaviour matches apps/web/src/components/reading/GlossaryTerms.tsx.
  function startGlossary() {
    listen(document, "pointerover", event => {
      if (!pointerKind(event)) return;
      const target = eventTarget(event);
      pointerTarget = target;
      if (insideCard(target)) { clearCloseTimer(); return; }
      const mark = markFor(target);
      if (!mark) return;
      if (openTerm && openTerm.mark === mark) clearCloseTimer();
      if (!(isNode(event.relatedTarget) && dom(window.Node.prototype, "contains", mark, event.relatedTarget))) delayOpen(mark);
    }, true);
    listen(document, "pointerout", event => {
      if (!pointerKind(event)) return;
      const target = eventTarget(event);
      if (event.relatedTarget === null) pointerTarget = null;
      if (!markFor(target) && !insideCard(target)) return;
      clearOpenTimer();
      if (insideOpen(event.relatedTarget)) { clearCloseTimer(); return; }
      if (insideOpen(target) && !focusedOpen()) {
        clearCloseTimer();
        leaveTimer = window.setTimeout(() => {
          leaveTimer = undefined;
          if (!hoveredOpen() && !focusedOpen()) closeCard();
        }, 300);
      }
    }, true);
    listen(document, "focusin", event => {
      if (restoringFocus) return;
      const target = eventTarget(event);
      if (focusedOpen(target)) clearCloseTimer();
      const mark = markFor(target);
      if (mark) delayOpen(mark);
    }, true);
    listen(document, "focusout", event => {
      clearOpenTimer();
      if (insideOpen(eventTarget(event)) && !focusedOpen(event.relatedTarget) && !hoveredOpen()) closeCard();
    }, true);
    listen(document, "click", event => {
      if (event.defaultPrevented) return;
      const mark = markFor(eventTarget(event));
      if (!mark) return;
      const selection = dom(window.Document.prototype, "getSelection", document);
      if (!selection || read(window.Selection.prototype, "isCollapsed", selection)) showCard(mark);
    });
    listen(document, "keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = eventTarget(event);
      if (!termMarks.has(target)) return;
      dom(window.Event.prototype, "preventDefault", event);
      showCard(target, true);
    });
    listen(document, "keydown", event => {
      if (event.key !== "Escape" || !openTerm) return;
      const inCard = cardFocused();
      if (focusedOpen()) {
        dom(window.Event.prototype, "preventDefault", event);
        dom(window.Event.prototype, "stopPropagation", event);
      }
      closeCard(inCard);
    }, true);
    listen(document, "pointerdown", event => {
      if (openTerm && !insideOpen(eventTarget(event))) closeCard();
    }, true);
    listen(window, "resize", positionCard, { passive: true });
    listen(window, "scroll", positionCard, { capture: true, passive: true });
  }
  let keptMarks = [], marked = [], changeLabels = [];
  let themeMode = "light";
  function applyChanged() {
    for (const { target, value, priority } of marked) {
      const style = styleOf(target);
      if (value) styleCall("setProperty", style, "box-shadow", value, priority);
      else styleCall("removeProperty", style, "box-shadow");
    }
    for (const host of changeLabels) {
      const parent = nodeValue("parentNode", host);
      if (parent) dom(window.Node.prototype, "removeChild", parent, host);
    }
    marked = [];
    changeLabels = [];
    const [line, background, color] = themeMode === "dark"
      ? ["#a78bfa", "rgba(139, 92, 246, 0.16)", "#c4b5fd"] : ["#8b5cf6", "#f5f3ff", "#6d28d9"];
    let previous;
    for (const mark of keptMarks) {
      const element = parts[mark.index];
      const diagram = diagrams.find(diagram => diagram.pre === element);
      const target = diagram?.host || element;
      const targetStyle = styleOf(target);
      marked.push({ target, value: styleCall("getPropertyValue", targetStyle, "box-shadow"),
        priority: styleCall("getPropertyPriority", targetStyle, "box-shadow") });
      styleCall("setProperty", targetStyle, "box-shadow", "-3px 0 0 0 " + line, "important");
      const continues = previous && previous.index === mark.index - 1 && previous.revision === mark.revision;
      previous = mark;
      if (continues) continue;
      const host = createElement("div");
      const hostStyle = styleOf(host);
      for (const [name, value] of [["all", "initial"], ["display", "block"], ["margin", "0 0 6px"]])
        styleCall("setProperty", hostStyle, name, value, "important");
      const shadow = elementCall("attachShadow", host, { mode: "closed" });
      const label = createElement("span");
      write(window.Element.prototype, "textContent", label, "Changed in rev " + mark.revision);
      const style = styleOf(label);
      for (const [name, value] of [["display", "inline-block"],
          ["font", "500 11.5px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"],
          ["padding", "0 7px 0 6px"], ["border-radius", "2px"], ["background", background],
          ["color", color], ["white-space", "nowrap"], ["user-select", "none"],
          ["text-align", "left"], ["letter-spacing", "normal"], ["text-transform", "none"]])
        styleCall("setProperty", style, name, value, "important");
      dom(window.Node.prototype, "appendChild", shadow, label);
      if (diagram?.host) dom(window.Node.prototype, "insertBefore", nodeValue("parentNode", target), host, target);
      else dom(window.Node.prototype, "insertBefore", target, host, nodeValue("firstChild", target));
      changeLabels.push(host);
    }
  }
  function changed(data) {
    const keys = Reflect.ownKeys(data);
    if (keys.length !== 3 || keys.some(key => !["type", "parts", "marks"].includes(key)) ||
        !Number.isInteger(data.parts) || data.parts < 0 || data.parts > HTML_PARTS_MAX ||
        !Array.isArray(data.marks) || data.marks.length > data.parts) return;
    let previous = -1;
    for (const mark of data.marks) {
      if (!mark || typeof mark !== "object" || Array.isArray(mark)) return;
      const prototype = Object.getPrototypeOf(mark);
      if (prototype !== null && prototype !== Object.prototype) return;
      const keys = Reflect.ownKeys(mark);
      if (keys.length !== 2 || keys.some(key => key !== "index" && key !== "revision") ||
          !Number.isInteger(mark.index) || mark.index < 0 || mark.index >= data.parts || mark.index <= previous ||
          !Number.isSafeInteger(mark.revision) || mark.revision < 1) return;
      previous = mark.index;
    }
    keptMarks = data.parts === parts.length ? data.marks : [];
    holdPosition(applyChanged);
  }
  function diagramMode(pre) {
    try {
      const parent = nodeValue("parentElement", pre) || documentElement();
      const computed = getComputedStyle.call(window, parent);
      const color = styleCall("getPropertyValue", computed, "color");
      const canvas = createElement("canvas");
      write(window.HTMLCanvasElement.prototype, "width", canvas, 1);
      write(window.HTMLCanvasElement.prototype, "height", canvas, 1);
      const context = dom(window.HTMLCanvasElement.prototype, "getContext", canvas, "2d", { colorSpace: "srgb" });
      if (!context) return "light";
      const prototype = window.CanvasRenderingContext2D.prototype;
      write(prototype, "fillStyle", context, color);
      dom(prototype, "fillRect", context, 0, 0, 1, 1);
      const pixel = dom(prototype, "getImageData", context, 0, 0, 1, 1);
      const rgb = read(window.ImageData.prototype, "data", pixel);
      const linear = byte => { const value = byte / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
      return linear(rgb[0]) * 0.2126 + linear(rgb[1]) * 0.7152 + linear(rgb[2]) * 0.0722 > 0.179 ? "dark" : "light";
    } catch { return "light"; }
  }
  function postDiagrams() {
    if (!diagrams.length || diagramRequest === DIAGRAM_REQUEST_MAX) return;
    post({ type: "emend:diagrams", request: ++diagramRequest, diagrams: diagrams.map(({ pre, host, source, mode }) => ({
      source, mode, width: Math.max(1, Math.min(DIAGRAM_DIMENSION_MAX, Math.round(bounds(host || pre).width) || 1))
    })) });
  }
  function diagramPre(pre) {
    if (nodeType(pre) !== 1 || namespace(pre) !== "http://www.w3.org/1999/xhtml" || localName(pre) !== "pre") return false;
    if ((elementCall("getAttribute", pre, "class") || "").split(/[\t\n\f\r ]+/).includes("mermaid")) return true;
    let code = false;
    for (const child of children(pre)) {
      const type = nodeType(child);
      if (type === 1) {
        if (code || namespace(child) !== "http://www.w3.org/1999/xhtml" || localName(child) !== "code" ||
            !(elementCall("getAttribute", child, "class") || "").split(/[\t\n\f\r ]+/).includes("language-mermaid")) return false;
        code = true;
      } else if (type !== 8 && (type !== 3 || /[^\t\n\f\r ]/.test(textData(child)))) return false;
    }
    return code;
  }
  function scanDiagrams() {
    if (!body()) return;
    let total = 0, earlier;
    for (const pre of nodes(body())) {
      if (!diagramPre(pre)) continue;
      if (earlier && dom(window.Node.prototype, "contains", earlier, pre)) continue;
      earlier = pre;
      const source = nodeValue("textContent", pre);
      if (!source.trim() || source.length > DIAGRAM_SOURCE_MAX) continue;
      if (total + source.length > DIAGRAM_TOTAL_MAX) break;
      total += source.length;
      diagrams.push({ pre, source, mode: diagramMode(pre) });
      if (diagrams.length === DIAGRAM_COUNT_MAX) break;
    }
    postDiagrams();
  }
  function checkDiagramModes() {
    let changed = false;
    for (const diagram of diagrams) {
      const mode = diagramMode(diagram.pre);
      if (mode !== diagram.mode) { diagram.mode = mode; changed = true; }
    }
    if (changed) postDiagrams();
  }
  function diagramSourceShown(diagram) {
    return !diagram.host || Array.from(ranges.values()).some(range => rangeCall("intersectsNode", range, diagram.pre));
  }
  function updateDiagramSource(diagram) {
    const style = styleOf(diagram.pre);
    const shown = diagramSourceShown(diagram);
    if (!shown) styleCall("setProperty", style, "display", "none", "important");
    else if (diagram.display) styleCall("setProperty", style, "display", diagram.display, diagram.priority);
    else styleCall("removeProperty", style, "display");
    diagram.sourceShown = shown;
  }
  function placeDiagram(data) {
    if (data.request !== diagramRequest || !Number.isInteger(data.index) || data.index < 0 || data.index >= diagrams.length) return;
    const dimension = value => Number.isInteger(value) && value >= 1 && value <= DIAGRAM_DIMENSION_MAX;
    const keys = data.svg === null ? ["type", "request", "index", "svg"] : ["type", "request", "index", "svg", "width", "height"];
    if (Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key))) return;
    if (data.svg !== null && (typeof data.svg !== "string" || data.svg.length > DIAGRAM_SVG_MAX ||
        !data.svg.startsWith("<svg") || !data.svg.isWellFormed() || !dimension(data.width) || !dimension(data.height))) return;
    const diagram = diagrams[data.index];
    if (data.svg === null && !diagram.host) return;
    holdPosition(() => {
      const style = styleOf(diagram.pre);
      if (data.svg === null) {
        dom(window.Node.prototype, "removeChild", nodeValue("parentNode", diagram.host), diagram.host);
        diagram.host = diagram.img = undefined;
        updateDiagramSource(diagram);
        applyChanged();
        return;
      }
      if (!diagram.host) {
        const host = createElement("div");
        elementCall("setAttribute", host, "data-emend-diagram", "");
        const shadow = elementCall("attachShadow", host, { mode: "closed" });
        const img = createElement("img");
        elementCall("setAttribute", img, "alt", "Diagram");
        const imageStyle = styleOf(img);
        for (const [name, value] of [["display", "block"], ["max-width", "100%"], ["height", "auto"]])
          styleCall("setProperty", imageStyle, name, value);
        dom(window.Node.prototype, "appendChild", shadow, img);
        dom(window.Node.prototype, "insertBefore", nodeValue("parentNode", diagram.pre), host, diagram.pre);
        diagram.host = host;
        diagram.img = img;
        diagram.display = styleCall("getPropertyValue", style, "display");
        diagram.priority = styleCall("getPropertyPriority", style, "display");
      }
      elementCall("setAttribute", diagram.img, "width", String(data.width));
      elementCall("setAttribute", diagram.img, "height", String(data.height));
      elementCall("setAttribute", diagram.img, "src", "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data.svg));
      updateDiagramSource(diagram);
      applyChanged();
    });
  }
  let themeSheet;
  function theme(data) {
    if (data.mode !== "dark" && data.mode !== "light") return;
    const key = value => typeof value === "string" && value.length <= 40 && /^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/.test(value);
    const number = "(?:0|[1-9][0-9]{0,2})(?:\\.[0-9]{0,5}[1-9])?";
    const oklch = new RegExp("^oklch\\(" + number + " " + number + " " + number + "(?: / " + number + ")?\\)$(?![\\s\\S])");
    const color = value => typeof value === "string" &&
      (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$(?![\s\S])/.test(value) || oklch.test(value));
    const entries = [];
    for (const [values, tokens] of [[data.scales, false], [data.tokens, true]]) {
      if (!values || typeof values !== "object" || Array.isArray(values)) return;
      const own = Object.entries(values);
      if (own.length > 256 || own.some(([name, value]) => !key(name) || !(color(value) || (tokens && key(value))))) return;
      entries.push(...own);
    }
    const root = documentElement();
    if (!root) return;
    elementCall("setAttribute", root, "data-theme", data.mode);
    if (typeof CSSStyleSheet !== "undefined" && descriptor(window.Document.prototype, "adoptedStyleSheets")) {
      try {
        if (!themeSheet) {
          const sheet = new CSSStyleSheet();
          write(window.Document.prototype, "adoptedStyleSheets", document, [...documentValue("adoptedStyleSheets"), sheet]);
          themeSheet = sheet;
        }
        const css = entries.map(([name, value]) => "--" + name + ":" + (color(value) ? value : "var(--" + value + ")") + ";").join("");
        dom(window.CSSStyleSheet.prototype, "replaceSync", themeSheet, css ? "@layer emend{:root:root:root{" + css + "}}" : "");
      } catch { /* The mode still applies without constructed stylesheet support. */ }
    }
    if (themeMode !== data.mode) {
      themeMode = data.mode;
      if (keptMarks.length) applyChanged();
    }
    checkDiagramModes();
  }
  listen(window, "message", event => {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
    if (event.data.type === "emend:layout" && typeof event.data.wide === "boolean") {
      const data = event.data;
      const preferences = "width" in data || "prose" in data || "code" in data;
      if (preferences && (!["comfortable", "wide", "narrow"].includes(data.width) ||
          !Number.isInteger(data.prose) || data.prose < 15 || data.prose > 18 ||
          !Number.isInteger(data.code) || data.code < 12 || data.code > 15)) return;
      const root = documentElement();
      if (!root) return;
      const attributes = [["data-emend-layout", data.wide ? "wide" : "narrow"]];
      if (preferences) attributes.push(["data-emend-width", data.width],
        ["data-emend-prose", String(data.prose)], ["data-emend-code", String(data.code)]);
      const changed = attributes.some(([name, value]) => elementCall("getAttribute", root, name) !== value);
      holdPosition(() => {
        for (const [name, value] of attributes) elementCall("setAttribute", root, name, value);
      }, changed);
    }
    else if (event.data.type === "emend:changed") changed(event.data);
    else if (event.data.type === "emend:diagram") placeDiagram(event.data);
    else if (event.data.type === "emend:theme") theme(event.data);
    else if (event.data.type === "emend:goto") goTo(event.data);
    else if (event.data.type === "emend:repo") linkIssues(event.data);
    else if (event.data.type === "emend:docs" && Array.isArray(event.data.paths)) {
      docs.clear();
      for (const path of event.data.paths) if (typeof path === "string") docs.add(path);
    }
    else if (event.data.type === "emend:highlight" && Array.isArray(event.data.anchors)) highlight(event.data.anchors);
    else if (event.data.type === "emend:scroll" && typeof event.data.threadId === "string") {
      const range = ranges.get(event.data.threadId);
      if (range) {
        const node = read(window.Range.prototype, "startContainer", range);
        const element = nodeType(node) === 1 ? node : nodeValue("parentElement", node);
        releasePin();
        if (element) elementCall("scrollIntoView", element, { block: "center" });
        schedulePosition();
      }
    }
  });
  listen(document, "mouseup", capture);
  listen(document, "keyup", capture);
  // Touch selections fire no mouseup or keyup; selectionchange covers them and handle drags.
  let settle = 0;
  listen(document, "selectionchange", () => {
    window.clearTimeout(settle);
    settle = window.setTimeout(capture, 200);
  });
  function linkHref(element) {
    const name = localName(element);
    const ns = namespace(element);
    if (ns === "http://www.w3.org/1999/xhtml" && (name === "a" || name === "area"))
      return elementCall("getAttribute", element, "href");
    if (ns === "http://www.w3.org/2000/svg" && name === "a")
      return elementCall("getAttribute", element, "href") ?? elementCall("getAttributeNS", element, "http://www.w3.org/1999/xlink", "href");
    return null;
  }
  function fragmentTarget(fragment, link) {
    const root = dom(window.Node.prototype, "getRootNode", link);
    const roots = root === document ? [document] : [document, root];
    // Document ids take precedence; a shadow link can also address its own root.
    for (const tree of roots) {
      const prototype = tree === document ? window.Document.prototype : window.DocumentFragment.prototype;
      const target = dom(prototype, "getElementById", tree, fragment);
      if (target) return target;
    }
    for (const tree of roots) {
      const prototype = tree === document ? window.Document.prototype : window.DocumentFragment.prototype;
      for (const anchor of dom(prototype, "querySelectorAll", tree, "a"))
        if (namespace(anchor) === "http://www.w3.org/1999/xhtml" && elementCall("getAttribute", anchor, "name") === fragment) return anchor;
    }
    return null;
  }
  // Images alone follow the rendered tree; heading and quote traversal stays unchanged.
  function* imageNodes(root) {
    const pending = [[root][Symbol.iterator]()];
    while (pending.length) {
      const next = pending[pending.length - 1].next();
      if (next.done) { pending.pop(); continue; }
      const node = next.value;
      if (nodeType(node) !== 1 || omitted.has(localName(node))) continue;
      if (namespace(node) === "http://www.w3.org/1999/xhtml" && localName(node) === "img") yield node;
      let branch = children(node);
      const shadow = elementValue("shadowRoot", node);
      if (shadow) branch = children(shadow);
      else if (namespace(node) === "http://www.w3.org/1999/xhtml" && localName(node) === "slot") {
        const assigned = dom(window.HTMLSlotElement.prototype, "assignedNodes", node, { flatten: false });
        if (assigned.length) branch = assigned;
      }
      pending.push(branch[Symbol.iterator]());
    }
  }
  const imageVisible = element => typeof window.Element.prototype.checkVisibility === "function"
    ? elementCall("checkVisibility", element, { checkVisibilityCSS: true, visibilityProperty: true, opacityProperty: true })
    : elementCall("getClientRects", element).length > 0;
  function srcsetChoice(value) {
    if (value.length > 16384) return "";
    const candidates = [];
    let cursor = 0;
    while (cursor < value.length) {
      while (cursor < value.length && /[\t\n\f\r ,]/.test(value[cursor])) cursor++;
      const start = cursor;
      while (cursor < value.length && !/[\t\n\f\r ]/.test(value[cursor])) cursor++;
      let url = value.slice(start, cursor), descriptor = "";
      if (url.endsWith(",")) {
        let end = url.length;
        while (end > 0 && url[end - 1] === ",") end--;
        url = url.slice(0, end);
      } else {
        const start = cursor;
        while (cursor < value.length && value[cursor] !== ",") cursor++;
        descriptor = value.slice(start, cursor).trim();
      }
      if (url) candidates.push({ url, descriptor });
    }
    const first = candidates[0]?.url || "";
    let best = first, largest = 0, kind;
    for (const candidate of candidates) {
      const descriptor = candidate.descriptor || "1x";
      if (descriptor.length > 32) return first;
      const unit = descriptor.at(-1);
      if (unit === "w") {
        if (!/^\d+w$/.test(descriptor)) return first;
      } else if (unit === "x") {
        // The alternatives require or exclude a decimal point, so digit runs cannot be repartitioned.
        if (!/^(?:\d+|\d*\.\d+|\d+\.)(?:[eE][+-]?\d+)?x$/.test(descriptor)) return first;
      } else return first;
      const size = Number(descriptor.slice(0, -1));
      if (!Number.isFinite(size) || size <= 0 || (kind && kind !== unit)) return first;
      kind = unit;
      if (size > largest) { best = candidate.url; largest = size; }
    }
    return best;
  }
  function galleryStep(budget) {
    if (!budget.remaining) return false;
    budget.remaining--;
    return true;
  }
  function pendingImageSource(element, sources, steps) {
    const parent = nodeValue("parentNode", element);
    if (parent && nodeType(parent) === 1 && namespace(parent) === "http://www.w3.org/1999/xhtml" && localName(parent) === "picture") {
      const siblings = children(parent)[Symbol.iterator]();
      for (let scanned = 0; scanned < 64; scanned++) {
        if (!steps.remaining) return "";
        const next = siblings.next();
        if (next.done) break;
        galleryStep(steps);
        const child = next.value;
        if (child === element) break;
        if (nodeType(child) !== 1 || namespace(child) !== "http://www.w3.org/1999/xhtml" || localName(child) !== "source") continue;
        let choice = sources.get(child);
        if (choice === undefined) {
          // Cache misses too, so rejected sources cannot repeat parsing work for every image.
          sources.set(child, "");
          const media = elementCall("getAttribute", child, "media");
          const type = elementCall("getAttribute", child, "type");
          if (media !== null && (media.length > 1024 || !read(window.MediaQueryList.prototype, "matches", matchMedia.call(window, media)))) continue;
          if (type !== null && !["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(type.split(";", 1)[0].trim().toLowerCase())) continue;
          choice = srcsetChoice(elementCall("getAttribute", child, "srcset") || "");
          sources.set(child, choice);
        }
        if (choice) return choice;
      }
    }
    if (!steps.remaining) return "";
    const srcset = elementCall("getAttribute", element, "srcset");
    return (srcset !== null ? srcsetChoice(srcset) : "") || elementCall("getAttribute", element, "src") || "";
  }
  function imagePath(element, urls, sources, steps) {
    if (!element || nodeType(element) !== 1 || namespace(element) !== "http://www.w3.org/1999/xhtml" ||
        localName(element) !== "img") return null;
    if (!galleryStep(steps) || !imageVisible(element)) return null;
    for (let parent = element; parent && parent !== body();) {
      if (!galleryStep(steps)) return null;
      parent = renderedParent(parent);
      if (!parent || parent === body()) break;
      if (nodeType(parent) === 1 && (linkHref(parent) !== null ||
          (namespace(parent) === "http://www.w3.org/1999/xhtml" && ["summary", "label", "button"].includes(localName(parent))))) return null;
    }
    try {
      const prototype = window.HTMLImageElement.prototype;
      const source = read(prototype, "currentSrc", element) || pendingImageSource(element, sources, steps);
      if (!source) return null;
      const url = new window.URL(source, urls.base ??= nodeValue("baseURI", document));
      const entry = /^(\/content\/[A-Za-z0-9_-]{43}[0-9a-f]{32}\/)(.*)$/.exec(window.location.pathname);
      if (!entry || url.origin !== window.location.origin || !url.pathname.startsWith(entry[1])) return null;
      const parts = url.pathname.slice(entry[1].length).split("/").map(part => decodeURIComponent(part));
      if (parts.some(part => !part || part === "." || part === ".." || /[/\\\x00-\x1f\x7f-\x9f]/u.test(part))) return null;
      const path = parts.join("/");
      if (path.length > 4096) return null;
      if (read(prototype, "complete", element) && read(prototype, "naturalWidth", element) < 48 &&
          read(prototype, "naturalHeight", element) < 48) return null;
      return path;
    } catch { return null; }
  }
  function captionLabel(root, budget) {
    const pending = [[root][Symbol.iterator]()];
    const parts = [];
    let left = 8000, visits = 64000;
    while (pending.length && left && visits && budget.remaining) {
      const next = pending[pending.length - 1].next();
      if (next.done) { pending.pop(); continue; }
      visits--;
      budget.remaining--;
      const node = next.value;
      if (nodeType(node) === 3) {
        const part = textData(node).slice(0, left);
        parts.push(part);
        left -= part.length;
      } else if (nodeType(node) === 1 && !omitted.has(localName(node))) {
        pending.push(children(node)[Symbol.iterator]());
      }
    }
    return budget.remaining ? cleanLabel(parts.join(""), 2000) : "";
  }
  function imageCaption(element, captions, budget, steps) {
    for (let parent = element; budget.remaining && parent && parent !== body();) {
      if (!galleryStep(steps)) return null;
      parent = renderedParent(parent);
      if (!parent || parent === body()) break;
      if (nodeType(parent) !== 1 || namespace(parent) !== "http://www.w3.org/1999/xhtml" || localName(parent) !== "figure") continue;
      let caption = captions.get(parent);
      if (caption === undefined) {
        caption = "";
        for (const child of children(parent)) {
          if (nodeType(child) === 1 && namespace(child) === "http://www.w3.org/1999/xhtml" && localName(child) === "figcaption") {
            caption = captionLabel(child, budget);
            break;
          }
        }
        captions.set(parent, caption);
      }
      if (caption) return caption;
      break;
    }
    return cleanLabel(elementCall("getAttribute", element, "alt") || "", 2000);
  }
  function imageGallery(clicked) {
    // Resolve the document base once per build; repeated DOM lookups can scan the whole pub.
    const urls = {};
    const sources = new Map();
    const stepBudget = { remaining: 1000000 };
    if (!body() || imagePath(clicked, urls, sources, stepBudget) === null || !stepBudget.remaining) return null;
    const collected = [];
    let index = -1, size = 0;
    for (const node of imageNodes(body())) {
      const path = imagePath(node, urls, sources, stepBudget);
      if (!stepBudget.remaining) break;
      if (path === null) continue;
      if (size + path.length > 1000000) break;
      size += path.length;
      if (node === clicked) index = collected.length;
      collected.push({ node, path });
      if (collected.length === 10000) break;
    }
    if (index < 0) return null;
    // Reserve every collected path before captions can spend the remaining message budget.
    const images = collected.map(({ path }) => ({ path, caption: "" }));
    const captions = new Map();
    const captionBudget = { remaining: 1000000 };
    for (let i = 0; i < collected.length; i++) {
      if (!stepBudget.remaining || !captionBudget.remaining) break;
      const caption = imageCaption(collected[i].node, captions, captionBudget, stepBudget);
      if (caption === null || !captionBudget.remaining) break;
      if (size + caption.length > 1000000) continue;
      images[i].caption = caption;
      size += caption.length;
    }
    return { type: "emend:image", images, index };
  }
  listen(document, "click", event => {
    if (event.defaultPrevented || event.button !== 0) return;
    const path = dom(window.Event.prototype, "composedPath", event);
    const link = path.find(node => node instanceof window.Element && linkHref(node) !== null);
    const issue = link && issueLinks.get(link);
    if (issue !== undefined) {
      dom(window.Event.prototype, "preventDefault", event);
      post({ type: "emend:issue", number: issue });
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!link) {
      const gallery = imageGallery(path.find(node => node instanceof window.Element));
      if (gallery) {
        post(gallery);
        dom(window.Event.prototype, "preventDefault", event);
      }
      return;
    }
    try {
      const current = new window.URL(window.location.href);
      const href = linkHref(link);
      const base = new window.URL(nodeValue("baseURI", document));
      const url = new window.URL(href, base);
      const sameDoc = url.origin === current.origin && url.pathname === current.pathname &&
        (!url.search || url.search === current.search);
      // URL parsing normalizes whitespace and accepts fragments that the resolver refuses.
      // Suppress the browser first, even when no bridge navigation is allowed below.
      if (sameDoc) {
        dom(window.Event.prototype, "preventDefault", event);
        if (!url.hash) { releasePin(); scrollTo(0); schedulePosition(); return; }
      }
      const entry = /^(\/content\/[A-Za-z0-9_-]{43}[0-9a-f]{32}\/)(.*)$/.exec(current.pathname);
      if (!entry) return;
      if (base.origin !== current.origin || !base.pathname.startsWith(entry[1])) return;
      const decodePath = path => path.split("/").map(part => decodeURIComponent(part)).join("/");
      const currentPath = decodePath(entry[2]);
      const known = new Set(docs);
      known.add(currentPath);
      const destination = resolve(decodePath(base.pathname.slice(entry[1].length)), href, known);
      if (!destination) return;
      dom(window.Event.prototype, "preventDefault", event);
      if (destination.path === currentPath) {
        if (!destination.fragment) { releasePin(); scrollTo(0); }
        else {
          const target = fragmentTarget(destination.fragment, link);
          if (!target) return;
          releasePin();
          scroll(target);
        }
        schedulePosition();
        return;
      }
      post({ type: "emend:navigate", ...destination });
    } catch { /* Malformed URLs keep their normal link behavior. */ }
  }, true);
  listen(document, "auxclick", event => {
    if (event.defaultPrevented || event.button !== 1) return;
    const path = dom(window.Event.prototype, "composedPath", event);
    const link = path.find(node => node instanceof window.Element && linkHref(node) !== null);
    const issue = link && issueLinks.get(link);
    if (issue === undefined) return;
    dom(window.Event.prototype, "preventDefault", event);
    post({ type: "emend:issue", number: issue });
  }, true);
  listen(window, "scroll", onScroll, { passive: true });
  listen(window, "resize", schedulePosition, { passive: true });
  listen(document, "scroll", onScroll, { capture: true, passive: true });
  for (const type of ["wheel", "touchmove", "keydown", "pointerdown", "touchend", "pointerup"])
    listen(document, type, schedulePosition, { capture: true, passive: true });
  listen(matchMedia.call(window, "(prefers-color-scheme: dark)"), "change", checkDiagramModes);
  const onDiagramMotionEnd = event => {
    const target = read(window.Event.prototype, "target", event);
    if (target instanceof window.Node && diagrams.some(({ pre }) => dom(window.Node.prototype, "contains", target, pre)))
      checkDiagramModes();
  };
  for (const type of ["transitionend", "transitioncancel", "animationend", "animationcancel"])
    listen(document, type, onDiagramMotionEnd, true);
  const ready = () => {
    readGlossary();
    markTerms();
    if (glossary.length) startGlossary();
    headings = collectHeadings();
    parts = collectParts();
    post({ type: "emend:ready" });
    scanDiagrams();
    schedulePosition();
  };
  if (documentValue("readyState") === "loading") listen(document, "DOMContentLoaded", ready, { once: true });
  else ready();
})();`;
