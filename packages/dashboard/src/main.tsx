import { StrictMode, useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  Link,
  createRouter,
  createRoute,
  createRootRoute,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

const rootRoute = createRootRoute({
  component: () => (
    <>
      <div className="p-2 flex gap-2">
        <Link to="/" className="[&.active]:font-bold">
          Home
        </Link>{' '}
        <Link to="/about" className="[&.active]:font-bold">
          About
        </Link>
      </div>
      <hr />
      <Outlet />
      <TanStackRouterDevtools />
    </>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: function Index() {
    const [ping, setPing] = useState<string>('…')
    const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('connecting')
    const wsRef = useRef<WebSocket | null>(null)

    useEffect(() => {
      fetch('/api/ping')
        .then((r) => r.text())
        .then(setPing)
        .catch((e) => setPing(`error: ${String(e)}`))
    }, [])

    useEffect(() => {
      const ws = new WebSocket(`ws://${location.host}/ws`)
      wsRef.current = ws
      ws.addEventListener('open', () => setWsState('open'))
      ws.addEventListener('close', () => setWsState('closed'))
      return () => ws.close()
    }, [])

    const sendPing = () => {
      wsRef.current?.send(JSON.stringify({ _tag: 'ping' }))
    }

    return (
      <div className="p-2">
        <h3>Welcome Home!</h3>
        <p>GET /api/ping → {ping}</p>
        <p>WS /ws → {wsState}</p>
        <button onClick={sendPing} disabled={wsState !== 'open'}>
          send ping
        </button>
      </div>
    )
  },
})

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/about',
  component: function About() {
    return <div className="p-2">Hello from About!</div>
  },
})

const routeTree = rootRoute.addChildren([indexRoute, aboutRoute])

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('app')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}
