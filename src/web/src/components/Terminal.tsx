import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useCardDetail } from '../hooks/useBoards'

export function Terminal({ cardId }: { cardId: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'connecting' | 'connected' | 'disconnected' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const { data: card } = useCardDetail(cardId)

  // Wait for card data before connecting
  const sessionId = card?.claude_session_id ?? null
  const cwd = card?.worktree_path ?? card?.directory_path ?? ''

  useEffect(() => {
    if (!containerRef.current || !card) return

    const term = new XTerm({
      fontSize: 12,
      fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: '#000000',
        foreground: '#cccccc',
        cursor: '#ffffff',
        selectionBackground: '#ffffff33',
        black: '#000000',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#6272a4',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#cccccc',
        brightBlack: '#555555',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)

    // Delay fit to ensure container has dimensions
    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch { /* not mounted yet */ }
    })

    setStatus('connecting')

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const params = new URLSearchParams()
    if (sessionId) params.set('sessionId', sessionId)
    if (cwd) params.set('cwd', cwd)
    const wsUrl = `${proto}://${location.host}/ws/pty/${cardId}?${params.toString()}`

    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      setStatus('connected')
      setErrorMsg(null)
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'data':
            term.write(msg.data)
            break
          case 'info':
            if (msg.command) {
              term.writeln(`\x1b[90m$ ${msg.command}\x1b[0m`)
            }
            if (!msg.alive && msg.command === null) {
              setStatus('disconnected')
            }
            break
          case 'exit':
            term.writeln(`\x1b[90m\r\nProcess exited (code: ${msg.exitCode})\x1b[0m`)
            setStatus('disconnected')
            break
          case 'error':
            term.writeln(`\x1b[31m${msg.message}\x1b[0m`)
            setStatus('error')
            setErrorMsg(msg.message)
            break
        }
      } catch {
        term.write(event.data)
      }
    }

    ws.onclose = () => setStatus('disconnected')
    ws.onerror = () => setStatus('error')

    // Forward keystrokes to the process
    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    // Resize on container change
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize' }))
        }
      } catch { /* container detached */ }
    })
    ro.observe(containerRef.current)

    return () => {
      inputDisposable.dispose()
      ro.disconnect()
      ws.close()
      term.dispose()
    }
  }, [cardId, card?.id, sessionId, cwd])

  const statusColors: Record<string, string> = {
    loading: 'bg-gray-400',
    connecting: 'bg-yellow-500',
    connected: 'bg-green-500',
    disconnected: 'bg-gray-500',
    error: 'bg-red-500',
  }

  return (
    <div className="flex flex-col h-full bg-black">
      <div ref={containerRef} className="flex-1 min-h-0 p-1" />
      <div className="flex items-center gap-1.5 px-2 py-1 border-t border-white/5">
        <div className={`h-1.5 w-1.5 rounded-full ${statusColors[status]}`} />
        <span className="text-[10px] text-neutral-500">
          {status === 'loading' ? 'Loading card...' :
           status === 'error' ? (errorMsg ?? 'Connection error') :
           status}
        </span>
      </div>
    </div>
  )
}
