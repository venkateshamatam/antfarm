import { create } from 'zustand'

interface AppState {
  // Board selection
  activeBoardId: number | null
  setActiveBoardId: (id: number | null) => void

  // Card selection & detail
  selectedCardId: number | null
  setSelectedCardId: (id: number | null) => void
  detailCardId: number | null
  openCardDetail: (id: number) => void
  closeCardDetail: () => void

  // Terminal panel
  terminalCardId: number | null
  terminalTab: 'terminal' | 'chat'
  openTerminal: (cardId: number, tab?: 'terminal' | 'chat') => void
  closeTerminal: () => void
  setTerminalTab: (tab: 'terminal' | 'chat') => void

  // Dialogs
  commandPaletteOpen: boolean
  setCommandPaletteOpen: (open: boolean) => void
  showCreateTask: boolean
  setShowCreateTask: (show: boolean) => void
  showDirectoryModal: boolean
  setShowDirectoryModal: (show: boolean) => void
  showHelp: boolean
  setShowHelp: (show: boolean) => void

  // Theme
  theme: 'light' | 'dark'
  toggleTheme: () => void

  // Sidebar
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
}

const savedTheme = localStorage.getItem('antfarm-theme') as 'light' | 'dark' | null
const initialTheme = savedTheme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
const savedSidebarWidth = parseInt(localStorage.getItem('antfarm-sidebar-width') ?? '420', 10)

export const useAppStore = create<AppState>((set) => ({
  activeBoardId: null,
  setActiveBoardId: (id) => set({ activeBoardId: id }),

  selectedCardId: null,
  setSelectedCardId: (id) => set({ selectedCardId: id }),
  detailCardId: null,
  openCardDetail: (id) => set({ detailCardId: id, selectedCardId: id }),
  closeCardDetail: () => set({ detailCardId: null }),

  terminalCardId: null,
  terminalTab: 'terminal',
  openTerminal: (cardId, tab = 'terminal') => set({ terminalCardId: cardId, terminalTab: tab }),
  closeTerminal: () => set({ terminalCardId: null }),
  setTerminalTab: (tab) => set({ terminalTab: tab }),

  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  showCreateTask: false,
  setShowCreateTask: (show) => set({ showCreateTask: show }),
  showDirectoryModal: false,
  setShowDirectoryModal: (show) => set({ showDirectoryModal: show }),
  showHelp: false,
  setShowHelp: (show) => set({ showHelp: show }),

  theme: initialTheme,
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem('antfarm-theme', next)
      document.documentElement.classList.toggle('dark', next === 'dark')
      return { theme: next }
    }),

  sidebarWidth: savedSidebarWidth,
  setSidebarWidth: (width) => {
    localStorage.setItem('antfarm-sidebar-width', String(width))
    set({ sidebarWidth: width })
  },
}))
