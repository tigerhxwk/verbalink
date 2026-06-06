import { create } from 'zustand';
import { api } from './api';

// One persistent <audio> that outlives the full-player overlay, so collapsing to the
// mini playbar keeps playback going. State mirrored into the store for the UI.
const audio = typeof window !== 'undefined' ? new Audio() : null;
if (audio) audio.preload = 'metadata';

// Actually-listened intervals, kept module-side and MUTATED so the ~4Hz timeupdate
// doesn't allocate or churn store state every tick (only `cur`/`maxRead` go to the store).
let listenRanges = [];
const sumRanges = () => listenRanges.reduce((a, r) => a + Math.max(0, r.end - r.start), 0);

export const usePlayer = create((set, get) => ({
  book: null, expanded: false, playing: false, cur: 0, dur: 0, maxRead: 0, speed: 1, vol: 1,
  ranges: [], essayBaseSec: 0, essayOpen: false,
  listenedSec: () => sumRanges(),
  markEssay: () => set({ essayBaseSec: sumRanges() }),
  // Opening an essay pauses playback, snapshots the listened ranges for the prompt,
  // and resets the "listened since last essay" baseline.
  openEssay: () => { audio.pause(); set({ essayOpen: true, essayBaseSec: sumRanges(), ranges: [...listenRanges] }); },
  closeEssay: () => set({ essayOpen: false }),
  chatOpen: false,
  openChat: () => set({ chatOpen: true }),
  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  closeChat: () => set({ chatOpen: false }),
  readerOpen: false,
  // Opening the reader pauses playback; closing it returns to the full player (back-button feel).
  openReader: () => { audio.pause(); set({ readerOpen: true, expanded: false }); },
  closeReader: () => set({ readerOpen: false, expanded: true }),
  // True while the player deck is sliding aside. Set from the deck's layout-animation callbacks,
  // read only by the cover/equalizer (leaf) so toggling it never re-renders/re-measures the deck.
  deckMoving: false,
  setDeckMoving: (v) => set({ deckMoving: v }),

  open(book) {
    const cur = get().book;
    if (!cur || cur.id !== book.id) {
      audio.src = `/api/books/${book.id}/audio`;
      audio.load();
      listenRanges = [];
      set({ book, cur: 0, dur: 0, maxRead: book.progress_sec || 0, playing: false, ranges: [], essayBaseSec: 0, essayOpen: false });
      const onMeta = () => {
        if (book.progress_sec) audio.currentTime = book.progress_sec;
        set({ dur: audio.duration || 0 });
        audio.removeEventListener('loadedmetadata', onMeta);
      };
      audio.addEventListener('loadedmetadata', onMeta);
    }
    set({ expanded: true });
  },
  expand: () => set({ expanded: true }),
  collapse: () => set({ expanded: false }),
  close() {
    audio.pause(); audio.removeAttribute('src'); audio.load();
    listenRanges = [];
    set({ book: null, expanded: false, playing: false, cur: 0, dur: 0, maxRead: 0, chatOpen: false, essayOpen: false, ranges: [], essayBaseSec: 0 });
  },
  toggle() { audio.paused ? audio.play().catch(() => {}) : audio.pause(); },
  pause() { audio.pause(); },
  resume() { audio.play().catch(() => {}); },
  seekTo(t) { audio.currentTime = t; set({ cur: t }); },
  playFrom(t) { audio.currentTime = t; audio.play().catch(() => {}); set({ cur: t }); },
  skip(d) { audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + d)); },
  setRate(v) { audio.playbackRate = v; set({ speed: v }); },
  setVolume(v) { audio.volume = v; set({ vol: v }); },
}));

if (audio) {
  audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime;
    if (!audio.paused) {
      const last = listenRanges[listenRanges.length - 1];
      if (last && t >= last.end && t - last.end < 2) last.end = t;  // continuous → extend
      else listenRanges.push({ start: t, end: t });                 // jump/fresh → new interval
    }
    usePlayer.setState((s) => ({ cur: t, maxRead: audio.paused ? s.maxRead : Math.max(s.maxRead, t) }));
  });
  audio.addEventListener('loadedmetadata', () => usePlayer.setState({ dur: audio.duration || 0 }));
  audio.addEventListener('play', () => usePlayer.setState({ playing: true }));
  audio.addEventListener('pause', () => usePlayer.setState({ playing: false }));
  // persist progress occasionally (best-effort)
  let last = 0;
  audio.addEventListener('timeupdate', () => {
    const b = usePlayer.getState().book;
    if (b && audio.currentTime - last > 5) { last = audio.currentTime; api('PUT', `/api/books/${b.id}/settings`, { progress_sec: audio.currentTime }).catch(() => {}); }
  });
}
