window.__ModuleLoader__.load({
  id: '@mappedinfo/dsh-qoder-dot',
  factory(require) {
    const { createElement: h, useEffect, useRef, useSyncExternalStore } = require('react')
    const { IconGlobeOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const id = 'qoder-dot'

    const dotOrigin = 'http://127.0.0.1:4320'

    function Panel({ source, catalog, openSession }) {
      const frame = useRef(null)
      const workspace = useSyncExternalStore(
        listener => source.subscribe(listener),
        () => source.getSnapshot(),
      )
      function sendProjects() {
        const { items, phase, state } = source.getSnapshot()
        frame.current?.contentWindow?.postMessage({
          type: 'qoder-dot/projects',
          canOpenSessions: true,
          status: state === 'error' ? 'unavailable' : phase === 'pending' ? 'loading' : 'ready',
          items: items.map(({ path, title }) => ({ path, title })),
        }, dotOrigin)
      }
      useEffect(sendProjects, [workspace])
      useEffect(() => {
        const onMessage = event => {
          if (event.origin !== dotOrigin || event.source !== frame.current?.contentWindow) return
          if (event.data?.type === 'qoder-dot/ready') {
            sendProjects()
            return
          }
          if (event.data?.type !== 'qoder-dot/open-session' || typeof event.data.id !== 'string') return
          const { ids } = catalog.getSnapshot()
          if (ids.includes(event.data.id)) openSession(event.data.id)
          else frame.current?.contentWindow?.postMessage({ type: 'qoder-dot/session-unavailable' }, dotOrigin)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [source, catalog, openSession])
      return h('iframe', {
        ref: frame,
        onLoad: sendProjects,
        src: dotOrigin + '/',
        title: 'Dot by QCA 主会话',
        referrerPolicy: 'no-referrer',
        style: { display: 'block', width: '100%', height: '100%', minHeight: 0, flex: 1, border: 0 },
      })
    }

    return {
      inject: ['slots', 'workspaces', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: id, inject: () => ({ source: ctx.workspaces.list, catalog: ctx.sessions.list,
            openSession: sessionId => ctx.uiWorkspace.openSession(sessionId) }),
        }, Panel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id, label: 'Dot by QCA', order: 15,
        }, IconGlobeOutlineRegular))
      },
    }
  },
})
