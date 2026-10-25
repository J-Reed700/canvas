# React architecture

`main.tsx` supplies the studio runtime and workspace store to `StudioProvider`, inside React Strict Mode.
Create these dependencies once, outside rendering, and keep their identity stable. Tests and embeddings
can use `createStudioRuntime()` and `createWorkspaceStore()` to supply independent instances.

```tsx
const runtime = createStudioRuntime({ storage: null });
const workspace = createWorkspaceStore(null);

<StudioProvider runtime={runtime} workspace={workspace}>
  <App />
</StudioProvider>
```

Passing `null` storage disables browser persistence. Omit it for browser storage, or supply a storage
adapter. Engine and video-bank factories and the audio transport can also be injected into the runtime.
The default application runtime remains available through `window.__studio` for browser diagnostics.

## Components and dependencies

- Read reactive state with `useStudioStore(selector)` or `useWorkspaceStore(selector)`. Select the fields
  a component needs; use `useShallow` when selecting a small object. Context holds stable dependencies,
  while Zustand subscriptions deliver state changes to their consumers.
- Use `useStudioApi()` for imperative reads and writes in event handlers, effects and ref callbacks.
  Use `useStudioRuntime()` for controller services. Controllers accept their store explicitly and
  contain no React hooks or imports of the default runtime.
- Use `useStudioElements()` for the preview, video-bank container and media input. These refs replace
  cross-component DOM searches for startup and importing files.
- Each public UI component has a named folder: `components/Card/Card.tsx` and
  `components/Card/Card.css`, for example. The implementation imports its adjacent stylesheet.
  Components that only compose other components or shared base controls reuse those styles. Tokens, resets and shared base
  controls stay in `studio/styles.css`; reusable interaction logic lives in `hooks/`.
- Shared controls and library presentation have independent modules. Their props describe values,
  content and callbacks. Sliders have associated labels and stable IDs. Library action hooks bind
  operations to the current provider.
- `WorkspaceLayout` subscribes to panel dimensions, so resizing updates the layout container without
  re-rendering unchanged panel children.

The renderer reads look data every frame. Existing look edits therefore remain mutable: an edit must
call `touch()` to publish a version change, and call `save()` or `rebuild()` as appropriate. Components
that render this data subscribe with `useVersion()`. Reads during rendering must not initialize or
mutate parameter holders. Parameter-marker refs release their renderer callbacks when detached.

## Effects and resource ownership

`App` composes panels. `useStudioLifecycle` owns the DOM session, `useStudioShortcuts` owns keyboard
shortcuts, and `useMediaDrop` owns drag-and-drop imports. `useWindowEvent` pairs subscription and cleanup
and uses an Effect Event to read the latest committed callback. Library keyboard navigation shares it.

Startup uses a generation check across awaits. A stopped or replaced initialization cannot install
late server state, start another render loop or register new subscriptions. Session cleanup stops
animation frames and polling, unregisters persistence listeners and store subscriptions, releases
video and GPU resources, and closes audio resources. The same runtime can start another DOM session.
Call `runtime.dispose()` when discarding the runtime itself; the provider borrows supplied instances.

Canvas drawing, thumbnail loading and existing imperative popovers remain DOM integration boundaries.
They use studio-owned controllers; the editor's fixed DOM IDs still assume one full editor per document.
Independent providers isolate editor state and services, rather than assigning unique IDs to every panel.

## Checks

`npm run lint:react` enforces hook call order, complete effect dependencies, JSX keys and stable context
values. It also runs in `npm run quality`. UI coverage includes the provider and lifecycle hooks.
The provider tests exercise state isolation, selector subscriptions, separate history and persistence,
Strict Mode cleanup, cancelled startup, stopped polling, reactive commands and parameter-ref cleanup.
