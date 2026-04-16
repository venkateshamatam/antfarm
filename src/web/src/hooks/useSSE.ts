import { useEffect, useRef, useState } from 'react'
import { queryClient } from '../main'

export function useSSE(url: string) {
  const [connected, setConnected] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let es: EventSource | null = null
    let retryDelay = 1000

    function invalidate() {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        queryClient.invalidateQueries()
      }, 400)
    }

    function connect() {
      es = new EventSource(url)

      es.onopen = () => {
        setConnected(true)
        retryDelay = 1000
      }

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'ping') return
          invalidate()
        } catch {
          // ignore parse errors
        }
      }

      es.onerror = () => {
        setConnected(false)
        es?.close()
        setTimeout(connect, retryDelay)
        retryDelay = Math.min(retryDelay * 1.5, 10000)
      }
    }

    connect()

    return () => {
      es?.close()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [url])

  return { connected }
}
