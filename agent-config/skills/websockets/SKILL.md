---
name: websockets
description: Real-time communication over WebSockets with a NestJS gateway. Use when the app needs live updates, chat, notifications, presence, collaborative editing, multiplayer state, or any server-pushed data — anything where polling would be too slow or wasteful.
---

# WebSockets

The platform proxies WebSocket upgrades end-to-end and keeps the app running while connections are open. Everything is preconfigured: `main.ts` registers the `WsAdapter`, and the Vite proxy forwards upgrades for paths under `/api`.

Two rules the setup depends on:

- **The gateway path must start with `/api`** (e.g. `/api/ws`). Gateways bypass the NestJS global prefix, so set it explicitly — any other prefix never reaches the backend.
- **Connect from the frontend on the same origin** — never hardcode a host or port.

## Server — gateway

A gateway is a provider like any service. Messages are JSON frames of the shape `{ "event": "...", "data": ... }`; `@SubscribeMessage("event")` routes on the `event` field, and a returned `{ event, data }` object is sent back to the sender.

```typescript
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  WebSocketGateway,
} from "@nestjs/websockets"
import { WebSocket } from "ws"

interface ChatMessage {
  author: string
  text: string
  sentAt: string
}

@WebSocketGateway({ path: "/api/ws" })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly clients = new Set<WebSocket>()
  private readonly history: ChatMessage[] = []

  handleConnection(client: WebSocket) {
    this.clients.add(client)
    client.send(JSON.stringify({ event: "history", data: this.history }))
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client)
  }

  @SubscribeMessage("message")
  onMessage(@MessageBody() body: { author: string; text: string }) {
    const message: ChatMessage = { ...body, sentAt: new Date().toISOString() }
    this.history.push(message)
    this.broadcast("message", message)
  }

  private broadcast(event: string, data: unknown) {
    const frame = JSON.stringify({ event, data })
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(frame)
    }
  }
}
```

Register it as a provider and add the module to `app.module.ts`, same as any service:

```typescript
@Module({
  providers: [ChatGateway],
})
export class ChatModule {}
```

The app runs as a single process, so in-memory state (connected clients, recent messages, presence) is correct and simple — no external broker needed. Memory does not survive an app restart; persist anything that must outlive one to SQLite and replay it on connection.

To push server-initiated events (from a schedule, another service, an LLM stream), inject the gateway and call its broadcast method.

## Frontend — hook with reconnect

```typescript
import { useEffect, useRef, useState } from "react"

type Frame = { event: string; data: unknown }

export function useWebSocket(onFrame: (frame: Frame) => void) {
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame

  useEffect(() => {
    let socket: WebSocket
    let retryTimer: ReturnType<typeof setTimeout>
    let disposed = false

    function connect() {
      const protocol = location.protocol === "https:" ? "wss" : "ws"
      socket = new WebSocket(`${protocol}://${location.host}/api/ws`)
      socketRef.current = socket
      socket.onopen = () => setConnected(true)
      socket.onmessage = (e) => onFrameRef.current(JSON.parse(e.data))
      socket.onclose = () => {
        setConnected(false)
        if (!disposed) retryTimer = setTimeout(connect, 2000)
      }
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(retryTimer)
      socket.close()
    }
  }, [])

  function send(event: string, data: unknown) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ event, data }))
    }
  }

  return { connected, send }
}
```

Always reconnect on close — the connection drops on backend restarts (every backend file save in dev) and network blips. Re-sync state from the server after each reconnect (like the `history` frame above) rather than assuming continuity.

## When NOT to use WebSockets

- One-way streaming of a single response (e.g. LLM output) — plain HTTP streaming is simpler.
- Data that changes rarely — fetch on demand or poll with react-query's `refetchInterval`.
