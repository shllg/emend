# React

This guide covers `apps/web/src`, recense's Vite single-page app with no server rendering.
`recense-react-reviewer` checks changes against it. Full rule texts are in
[docs/vendor/vercel-agent-skills/](vendor/vercel-agent-skills/).

## Style

### Composition patterns

- [architecture-avoid-boolean-props](vendor/vercel-agent-skills/composition-patterns/rules/architecture-avoid-boolean-props.md) — CRITICAL: Compose component parts instead of adding boolean props for each mode.
- [architecture-compound-components](vendor/vercel-agent-skills/composition-patterns/rules/architecture-compound-components.md) — HIGH: Build complex components from pieces that share state through context.
- [patterns-children-over-render-props](vendor/vercel-agent-skills/composition-patterns/rules/patterns-children-over-render-props.md) — MEDIUM: Prefer children for static composition, reserving render props for data the parent must supply.
- [patterns-explicit-variants](vendor/vercel-agent-skills/composition-patterns/rules/patterns-explicit-variants.md) — MEDIUM: Give distinct component modes their own composed variants instead of combining boolean switches.
- [react19-no-forwardref](vendor/vercel-agent-skills/composition-patterns/rules/react19-no-forwardref.md) — MEDIUM: In React 19, pass ref as a prop and read context with use().
- [state-context-interface](vendor/vercel-agent-skills/composition-patterns/rules/state-context-interface.md) — HIGH: Give shared context a state, actions and meta interface that different providers can implement.
- [state-decouple-implementation](vendor/vercel-agent-skills/composition-patterns/rules/state-decouple-implementation.md) — MEDIUM: Keep state machinery inside the provider so consumers depend only on its interface.
- [state-lift-state](vendor/vercel-agent-skills/composition-patterns/rules/state-lift-state.md) — HIGH: Lift shared state into a provider so sibling components can use it without passing it through unrelated parents.

### Rules of React

From [Rules of React](https://react.dev/reference/rules):

- Keep components and hooks pure: the same inputs produce the same output.
- Let React call components through JSX and manage hook calls within components and custom hooks.
- Call hooks at the top level of a component or hook, never inside branches, loops or callbacks.
- Treat props, state and hook arguments as immutable inputs.
- Run side effects outside render, in event handlers or effects.

### You Might Not Need an Effect

From [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect):

- Derive values during render instead of keeping a second state value in sync.
- Handle a user action in its event handler.
- Reset a component's state with a new `key` when its identity changes.
- Cache work with `useMemo` only after measuring that it is expensive.
- Use an effect to synchronize with something outside React, and clean up that synchronization.

### Existing conventions

- Name component files in PascalCase and export named functions, as in [apps/web/src/components/status/StateBadge.tsx](../apps/web/src/components/status/StateBadge.tsx).
- Put shared hooks in `lib`, as in [apps/web/src/lib/use-reading-position.ts](../apps/web/src/lib/use-reading-position.ts).
- Define server-data queries in `api` with contract schemas and TanStack Query, as in [apps/web/src/api/queries.ts](../apps/web/src/api/queries.ts).
- Give components typed props and callbacks, as in [apps/web/src/components/reading/Block.tsx](../apps/web/src/components/reading/Block.tsx).
- Combine Tailwind classes and theme tokens with `cn`, as in [apps/web/src/components/ui/Button.tsx](../apps/web/src/components/ui/Button.tsx).
- Keep Vitest and Testing Library tests beside the UI they exercise, as in [apps/web/src/components/ui/components.test.tsx](../apps/web/src/components/ui/components.test.tsx).
- Render Markdown HTML through the server-sanitized boundary, as in [apps/web/src/components/reading/BlockView.tsx](../apps/web/src/components/reading/BlockView.tsx).
- Render agent HTML documents in a sandboxed content frame, as in [apps/web/src/components/reading/HtmlDocFrame.tsx](../apps/web/src/components/reading/HtmlDocFrame.tsx).

## Performance

### async

- [async-api-routes](vendor/vercel-agent-skills/react-best-practices/rules/async-api-routes.md) — CRITICAL: Starting independent work early in API routes and Server Actions does not apply to this client-only Vite app.
- [async-cheap-condition-before-await](vendor/vercel-agent-skills/react-best-practices/rules/async-cheap-condition-before-await.md) — HIGH: Check a cheap local condition before starting an async operation that the condition may make unnecessary.
- [async-defer-await](vendor/vercel-agent-skills/react-best-practices/rules/async-defer-await.md) — HIGH: Await a result only in the branch that needs it.
- [async-dependencies](vendor/vercel-agent-skills/react-best-practices/rules/async-dependencies.md) — CRITICAL: Start each async operation as soon as its own dependencies are ready, using existing promise tools here.
- [async-parallel](vendor/vercel-agent-skills/react-best-practices/rules/async-parallel.md) — CRITICAL: Run independent async operations together with Promise.all().
- [async-suspense-boundaries](vendor/vercel-agent-skills/react-best-practices/rules/async-suspense-boundaries.md) — HIGH: The async server-component streaming example does not apply here; client Suspense boundaries can still keep a shell visible while supported content loads.

### bundle

- [bundle-analyzable-paths](vendor/vercel-agent-skills/react-best-practices/rules/bundle-analyzable-paths.md) — HIGH: Use literal import paths or explicit maps so Vite can determine which modules to include.
- [bundle-barrel-imports](vendor/vercel-agent-skills/react-best-practices/rules/bundle-barrel-imports.md) — CRITICAL: Use supported direct imports when a barrel pulls a large unused module graph into the build.
- [bundle-conditional](vendor/vercel-agent-skills/react-best-practices/rules/bundle-conditional.md) — HIGH: Load a large module or dataset when its feature is activated.
- [bundle-defer-third-party](vendor/vercel-agent-skills/react-best-practices/rules/bundle-defer-third-party.md) — MEDIUM: Defer nonessential third-party code until after the initial client render; the hydration example does not apply here and telemetry remains forbidden.
- [bundle-dynamic-imports](vendor/vercel-agent-skills/react-best-practices/rules/bundle-dynamic-imports.md) — CRITICAL: Lazy-load large components with React.lazy and import() here; next/dynamic is specific to Next.js.
- [bundle-preload](vendor/vercel-agent-skills/react-best-practices/rules/bundle-preload.md) — MEDIUM: Preload a heavy bundle when user intent makes its use likely.

### client

- [client-event-listeners](vendor/vercel-agent-skills/react-best-practices/rules/client-event-listeners.md) — LOW: Share global event listeners across component instances instead of registering one per consumer.
- [client-localstorage-schema](vendor/vercel-agent-skills/react-best-practices/rules/client-localstorage-schema.md) — MEDIUM: Version storage keys, save only needed fields and handle unavailable or malformed storage.
- [client-passive-event-listeners](vendor/vercel-agent-skills/react-best-practices/rules/client-passive-event-listeners.md) — MEDIUM: Use passive touch and wheel listeners when they never need to prevent scrolling.
- [client-swr-dedup](vendor/vercel-agent-skills/react-best-practices/rules/client-swr-dedup.md) — MEDIUM-HIGH: Share request caching and deduplication across consumers, using the app's existing TanStack Query cache.

### rerender

- [rerender-defer-reads](vendor/vercel-agent-skills/react-best-practices/rules/rerender-defer-reads.md) — MEDIUM: Read values used only in callbacks when the callback runs instead of subscribing during render.
- [rerender-dependencies](vendor/vercel-agent-skills/react-best-practices/rules/rerender-dependencies.md) — LOW: Depend on the primitive values an effect uses rather than a larger object's identity.
- [rerender-derived-state-no-effect](vendor/vercel-agent-skills/react-best-practices/rules/rerender-derived-state-no-effect.md) — MEDIUM: Compute values from current props and state during render instead of storing a synchronized copy.
- [rerender-derived-state](vendor/vercel-agent-skills/react-best-practices/rules/rerender-derived-state.md) — MEDIUM: Subscribe to the derived value the UI needs instead of every change to its underlying value.
- [rerender-functional-setstate](vendor/vercel-agent-skills/react-best-practices/rules/rerender-functional-setstate.md) — MEDIUM: Use an updater function when the next state depends on the previous state.
- [rerender-lazy-state-init](vendor/vercel-agent-skills/react-best-practices/rules/rerender-lazy-state-init.md) — MEDIUM: Pass an initializer function to useState when computing the initial value is expensive.
- [rerender-memo-with-default-value](vendor/vercel-agent-skills/react-best-practices/rules/rerender-memo-with-default-value.md) — MEDIUM: Hoist object, array and function defaults to constants when their identity affects memoization.
- [rerender-memo](vendor/vercel-agent-skills/react-best-practices/rules/rerender-memo.md) — MEDIUM: Put expensive work in a memoized child so the parent can return early without doing that work.
- [rerender-move-effect-to-event](vendor/vercel-agent-skills/react-best-practices/rules/rerender-move-effect-to-event.md) — MEDIUM: Perform work caused by a user action in its event handler instead of a state-triggered effect.
- [rerender-no-inline-components](vendor/vercel-agent-skills/react-best-practices/rules/rerender-no-inline-components.md) — HIGH: Define component types outside other components and pass their inputs as props to avoid remounts.
- [rerender-simple-expression-in-memo](vendor/vercel-agent-skills/react-best-practices/rules/rerender-simple-expression-in-memo.md) — LOW-MEDIUM: Calculate cheap primitive expressions directly instead of wrapping them in useMemo.
- [rerender-split-combined-hooks](vendor/vercel-agent-skills/react-best-practices/rules/rerender-split-combined-hooks.md) — MEDIUM: Split independent computations or effects with different dependencies into separate hooks.
- [rerender-transitions](vendor/vercel-agent-skills/react-best-practices/rules/rerender-transitions.md) — MEDIUM: Mark nonurgent state updates as transitions so urgent interactions stay responsive.
- [rerender-use-deferred-value](vendor/vercel-agent-skills/react-best-practices/rules/rerender-use-deferred-value.md) — MEDIUM: Defer values feeding expensive renders and memoize their costly computation to keep input responsive.
- [rerender-use-ref-transient-values](vendor/vercel-agent-skills/react-best-practices/rules/rerender-use-ref-transient-values.md) — MEDIUM: Store frequently changing values in refs when their updates should not render the UI.

### rendering

- [rendering-activity](vendor/vercel-agent-skills/react-best-practices/rules/rendering-activity.md) — MEDIUM: Use Activity to preserve state and DOM for expensive views that frequently hide and return.
- [rendering-animate-svg-wrapper](vendor/vercel-agent-skills/react-best-practices/rules/rendering-animate-svg-wrapper.md) — LOW: Animate a wrapper around an SVG when that lets the browser accelerate the animation.
- [rendering-conditional-render](vendor/vercel-agent-skills/react-best-practices/rules/rendering-conditional-render.md) — LOW: Use an explicit conditional when a falsy number would otherwise appear in the rendered output.
- [rendering-content-visibility](vendor/vercel-agent-skills/react-best-practices/rules/rendering-content-visibility.md) — HIGH: Use content-visibility: auto to defer layout and paint for offscreen list items.
- [rendering-hoist-jsx](vendor/vercel-agent-skills/react-best-practices/rules/rendering-hoist-jsx.md) — LOW: Move unchanged JSX outside a component so each render reuses it.
- [rendering-hydration-no-flicker](vendor/vercel-agent-skills/react-best-practices/rules/rendering-hydration-no-flicker.md) — MEDIUM: The pre-hydration DOM adjustment does not apply because this Vite app does not render HTML on the server.
- [rendering-hydration-suppress-warning](vendor/vercel-agent-skills/react-best-practices/rules/rendering-hydration-suppress-warning.md) — LOW-MEDIUM: Suppressing expected hydration differences does not apply because this Vite app has no hydration.
- [rendering-resource-hints](vendor/vercel-agent-skills/react-best-practices/rules/rendering-resource-hints.md) — HIGH: Use React DOM resource hints to start loading resources the browser will soon need.
- [rendering-script-defer-async](vendor/vercel-agent-skills/react-best-practices/rules/rendering-script-defer-async.md) — HIGH: Use defer for ordered external classic scripts and async for independent ones so they do not block HTML parsing.
- [rendering-svg-precision](vendor/vercel-agent-skills/react-best-practices/rules/rendering-svg-precision.md) — LOW: Reduce SVG coordinate precision where the image remains visually unchanged.
- [rendering-usetransition-loading](vendor/vercel-agent-skills/react-best-practices/rules/rendering-usetransition-loading.md) — LOW: Use useTransition's pending state for transition work instead of maintaining a separate loading flag.

### js

- [js-batch-dom-css](vendor/vercel-agent-skills/react-best-practices/rules/js-batch-dom-css.md) — MEDIUM: Separate DOM writes from layout reads to avoid repeated synchronous layout.
- [js-cache-function-results](vendor/vercel-agent-skills/react-best-practices/rules/js-cache-function-results.md) — MEDIUM: Cache repeated pure function results by input when render paths reuse them.
- [js-cache-property-access](vendor/vercel-agent-skills/react-best-practices/rules/js-cache-property-access.md) — LOW-MEDIUM: Read a repeated property lookup once inside a hot path.
- [js-cache-storage](vendor/vercel-agent-skills/react-best-practices/rules/js-cache-storage.md) — LOW-MEDIUM: Cache synchronous browser-storage reads in memory and invalidate the cache when their values change.
- [js-combine-iterations](vendor/vercel-agent-skills/react-best-practices/rules/js-combine-iterations.md) — LOW-MEDIUM: Combine array passes when the same loop can collect the needed results.
- [js-early-exit](vendor/vercel-agent-skills/react-best-practices/rules/js-early-exit.md) — LOW-MEDIUM: Return as soon as the result is known instead of processing the remaining inputs.
- [js-flatmap-filter](vendor/vercel-agent-skills/react-best-practices/rules/js-flatmap-filter.md) — LOW-MEDIUM: Use flatMap to transform and omit items without a separate filter pass.
- [js-hoist-regexp](vendor/vercel-agent-skills/react-best-practices/rules/js-hoist-regexp.md) — LOW-MEDIUM: Reuse regular expressions instead of rebuilding them during each render.
- [js-index-maps](vendor/vercel-agent-skills/react-best-practices/rules/js-index-maps.md) — LOW-MEDIUM: Build a Map for repeated searches by the same key.
- [js-length-check-first](vendor/vercel-agent-skills/react-best-practices/rules/js-length-check-first.md) — MEDIUM-HIGH: Compare array lengths before an expensive equality check.
- [js-min-max-loop](vendor/vercel-agent-skills/react-best-practices/rules/js-min-max-loop.md) — LOW: Find an extremum in one pass instead of sorting the whole array.
- [js-request-idle-callback](vendor/vercel-agent-skills/react-best-practices/rules/js-request-idle-callback.md) — MEDIUM: Schedule noncritical work with requestIdleCallback when available, with a fallback and cleanup.
- [js-set-map-lookups](vendor/vercel-agent-skills/react-best-practices/rules/js-set-map-lookups.md) — LOW-MEDIUM: Use a Set or Map for repeated membership checks.
- [js-tosorted-immutable](vendor/vercel-agent-skills/react-best-practices/rules/js-tosorted-immutable.md) — MEDIUM-HIGH: Use toSorted instead of mutating arrays owned by props or state.

### advanced

- [advanced-effect-event-deps](vendor/vercel-agent-skills/react-best-practices/rules/advanced-effect-event-deps.md) — LOW: Keep Effect Events out of effect dependencies while retaining the reactive values the effect actually uses.
- [advanced-event-handler-refs](vendor/vercel-agent-skills/react-best-practices/rules/advanced-event-handler-refs.md) — LOW: Keep a callback in a ref when its changing identity should not recreate an effect's subscription.
- [advanced-init-once](vendor/vercel-agent-skills/react-best-practices/rules/advanced-init-once.md) — LOW-MEDIUM: Initialize app-wide work at module scope or behind a module guard so component remounts cannot repeat it.
- [advanced-use-latest](vendor/vercel-agent-skills/react-best-practices/rules/advanced-use-latest.md) — LOW: Use a latest-value ref for callbacks that need current values without resubscribing their effect.

A breach of a rule in this guide is a defect; anything beyond it is a preference.
The non-negotiables in `AGENTS.md` and `.claude/rules/content-isolation.md` win over any rule here; a vendored rule that conflicts with them does not apply (for example third-party preconnects or scripts).
