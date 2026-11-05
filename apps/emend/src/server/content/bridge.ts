export const BRIDGE_SOURCE = String.raw`(() => {
  "use strict";
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
  const docs = new Set();
  let headings = [];
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
  function label(root) {
    let left = 800;
    const parts = [];
    for (const node of nodes(root, 6400)) {
      if (nodeType(node) !== 3) continue;
      const part = textData(node).slice(0, left);
      parts.push(part);
      left -= part.length;
      if (!left) break;
    }
    const discarded = [[0,31],[127,159],[847,847],[1564,1564],[4447,4448],[8203,8207],[8234,8238],
      [8288,8303],[12644,12644],[65024,65039],[65279,65279],[65440,65440],[65529,65531],
      [917504,917631],[917760,917999]];
    return Array.from(parts.join("").replace(/[\s\x85]/gu, " "))
      .filter(char => !discarded.some(([from, to]) => char.codePointAt(0) >= from && char.codePointAt(0) <= to))
      .join("").replace(/ +/g, " ").trim().toWellFormed().slice(0, 200).replace(/[\uD800-\uDBFF]$/, "").trim();
  }
  function collectHeadings() {
    if (!body()) return [];
    const depth = [{ node: documentElement(), level: 1 }];
    const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    while (depth.length) {
      const { node, level } = depth.pop();
      if (nodeType(node) !== 1) continue;
      if (level > 512 && !(namespace(node) === "http://www.w3.org/1999/xhtml" && voids.has(localName(node)))) return [];
      const content = localName(node) === "template" && namespace(node) === "http://www.w3.org/1999/xhtml"
        ? read(window.HTMLTemplateElement.prototype, "content", node) : node;
      for (const child of children(content)) depth.push({ node: child, level: level + 1 });
    }
    const found = [];
    for (const node of nodes(body())) {
      if (nodeType(node) !== 1 || namespace(node) !== "http://www.w3.org/1999/xhtml" ||
          (localName(node) !== "h2" && localName(node) !== "h3")) continue;
      found.push({ element: node, label: label(node) });
      if (found.length === 1024) break;
    }
    return found;
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
  function capture() {
    const selection = dom(window.Document.prototype, "getSelection", document);
    if (!selection || read(window.Selection.prototype, "isCollapsed", selection) || read(window.Selection.prototype, "rangeCount", selection) !== 1 || !body()) return;
    const range = dom(window.Selection.prototype, "getRangeAt", selection, 0);
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
  function highlight(anchors) {
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
  }
  listen(window, "message", event => {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
    if (event.data.type === "emend:goto") goTo(event.data);
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
  listen(document, "click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = dom(window.Event.prototype, "composedPath", event)
      .find(node => node instanceof window.Element && linkHref(node) !== null);
    if (!link) return;
    try {
      const current = new window.URL(window.location.href);
      const href = linkHref(link);
      const base = new window.URL(nodeValue("baseURI", document));
      const url = new window.URL(href, base);
      const sameDoc = url.href.split("#")[0] === current.href.split("#")[0];
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
  listen(window, "scroll", onScroll, { passive: true });
  listen(window, "resize", schedulePosition, { passive: true });
  listen(document, "scroll", onScroll, { capture: true, passive: true });
  for (const type of ["wheel", "touchmove", "keydown", "pointerdown", "touchend", "pointerup"])
    listen(document, type, schedulePosition, { capture: true, passive: true });
  const ready = () => { headings = collectHeadings(); post({ type: "emend:ready" }); schedulePosition(); };
  if (documentValue("readyState") === "loading") listen(document, "DOMContentLoaded", ready, { once: true });
  else ready();
})();`;
