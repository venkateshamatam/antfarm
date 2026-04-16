import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useAppStore } from '../store'

const SHORTCUTS = [
  { keys: ['j', '↓'], desc: 'Next card' },
  { keys: ['k', '↑'], desc: 'Previous card' },
  { keys: ['h', '←'], desc: 'Previous column' },
  { keys: ['l', '→'], desc: 'Next column' },
  { keys: ['Enter'], desc: 'Open card detail' },
  { keys: ['Escape'], desc: 'Close / deselect' },
  { keys: ['S'], desc: 'Generate spec' },
  { keys: ['A'], desc: 'Approve' },
  { keys: ['D'], desc: 'Delete card' },
  { keys: ['R'], desc: 'Retry errored card' },
  { keys: ['?'], desc: 'Toggle this overlay' },
]

export function ShortcutOverlay() {
  const { showHelp, setShowHelp } = useAppStore()

  return (
    <Dialog open={showHelp} onOpenChange={setShowHelp}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          {SHORTCUTS.map(s => (
            <div key={s.desc} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{s.desc}</span>
              <div className="flex gap-1">
                {s.keys.map(k => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
