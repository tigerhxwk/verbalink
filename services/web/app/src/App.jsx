import { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useStore } from './store';
import { usePlayer } from './player';
import { api } from './api';
import Login from './screens/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import MobileNav from './components/MobileNav.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Settings from './screens/Settings.jsx';
import Membership from './screens/Membership.jsx';
import Player from './screens/Player.jsx';
import MiniPlayer from './components/MiniPlayer.jsx';
import ChatWidget from './components/ChatWidget.jsx';
import Reader from './screens/Reader.jsx';
import AddBook from './components/AddBook.jsx';
import EssayHost from './components/EssayHost.jsx';

export default function App() {
  const { user, setUser } = useStore();
  const [checked, setChecked] = useState(false);
  const [page, setPage] = useState('dashboard');
  const [showAdd, setShowAdd] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { book, expanded, readerOpen, open } = usePlayer();

  useEffect(() => {
    api('GET', '/api/auth/me').then(setUser).catch(() => {}).finally(() => setChecked(true));
  }, [setUser]);

  if (!checked) return null;
  if (!user) return <Login />;

  const onAdd = () => setShowAdd(true);

  return (
    <div className="flex h-full">
      <Sidebar page={page} setPage={setPage} onAdd={onAdd} className="hidden md:flex" />

      <div className="flex-1 flex flex-col min-w-0">
        <MobileNav page={page} setPage={setPage} onAdd={onAdd} className="md:hidden" />
        {page === 'settings' ? <Settings setPage={setPage} />
          : page === 'membership' ? <Membership setPage={setPage} />
          : <Dashboard key={reloadKey} page={page} onOpenBook={open} onAdd={onAdd} />}
      </div>

      {book && !expanded && !readerOpen && <MiniPlayer />}
      <AnimatePresence>{book && expanded && <Player />}</AnimatePresence>
      <AnimatePresence>{book && readerOpen && <Reader />}</AnimatePresence>
      <ChatWidget />
      <EssayHost />
      <AnimatePresence>
        {showAdd && <AddBook onClose={() => setShowAdd(false)} onUploaded={() => setReloadKey((k) => k + 1)} />}
      </AnimatePresence>
    </div>
  );
}
