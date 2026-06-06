import { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { api } from '../api';
import { usePlayer } from '../player';
import EssaySheet from './EssaySheet';

// Lives at the app root so practice essays trigger whether the full player is open,
// minimized to the mini bar, or the reader is up — anywhere a book is playing.
export default function EssayHost() {
  const { book, cur, essayOpen, essayBaseSec, openEssay, closeEssay } = usePlayer();
  const [enabled, setEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState(30);

  useEffect(() => {
    api('GET', '/api/settings').then((s) => { setEnabled(!!s.essay_enabled); setIntervalMin(s.essay_interval_min || 30); }).catch(() => {});
  }, [book]);

  useEffect(() => {
    if (!book || !enabled || essayOpen) return;
    if (usePlayer.getState().listenedSec() - essayBaseSec >= intervalMin * 60) openEssay();
  }, [cur, book, enabled, essayOpen, intervalMin, essayBaseSec]);

  if (!book) return null;
  return (
    <AnimatePresence>
      {essayOpen && (
        <EssaySheet bookId={book.id} positionSec={cur} ranges={usePlayer.getState().ranges} onClose={closeEssay} />
      )}
    </AnimatePresence>
  );
}
