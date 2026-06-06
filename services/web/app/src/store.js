import { create } from 'zustand';

export function applyTheme(pref) {
  const dark = pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

// Global app state (auth, theme, current book/playback grows here as screens port).
export const useStore = create((set) => ({
  user: null,
  theme: localStorage.getItem('theme') || 'system',
  setUser: (user) => set({ user }),
  setTheme: (theme) => { localStorage.setItem('theme', theme); applyTheme(theme); set({ theme }); },
}));
