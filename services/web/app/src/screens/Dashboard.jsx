import { useEffect, useState } from 'react';
import { api } from '../api';
import BookCard from '../components/BookCard';
import Librarian from '../components/Librarian';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function Grid({ books, onOpenBook }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
      {books.map((b) => <BookCard key={b.id} book={b} onOpen={onOpenBook} />)}
    </div>
  );
}

function AddButton({ onAdd }) {
  return (
    <button onClick={onAdd}
      className="hidden md:inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add book
    </button>
  );
}

export default function Dashboard({ page, onOpenBook, onAdd }) {
  const [books, setBooks] = useState(null);
  const [collections, setCollections] = useState(null);
  const [openColl, setOpenColl] = useState(null);   // selected collection
  const [collBooks, setCollBooks] = useState(null);  // its books

  useEffect(() => { api('GET', '/api/books').then(setBooks).catch(() => setBooks([])); }, []);
  useEffect(() => {
    if (page === 'collections') api('GET', '/api/collections').then(setCollections).catch(() => setCollections([]));
    else setOpenColl(null);
  }, [page]);
  useEffect(() => {
    if (!openColl) { setCollBooks(null); return; }
    setCollBooks(null);
    api('GET', `/api/collections/${openColl.id}/books`).then(setCollBooks).catch(() => setCollBooks([]));
  }, [openColl]);

  // ── Collections ──
  if (page === 'collections') {
    // collection detail
    if (openColl) {
      return (
        <main className="flex-1 overflow-y-auto">
          <header className="px-5 sm:px-8 pt-6 sm:pt-8 pb-5 border-b border-border">
            <button onClick={() => setOpenColl(null)} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-2 transition">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              Collections
            </button>
            <h1 className="font-body font-bold text-2xl sm:text-3xl text-foreground">{openColl.name}</h1>
          </header>
          <section className="p-5 sm:p-8 pb-24 md:pb-8">
            {collBooks === null ? <div className="text-muted-foreground">Loading…</div>
              : collBooks.length === 0 ? <div className="text-muted-foreground">This collection is empty.</div>
              : <Grid books={collBooks} onOpenBook={onOpenBook} />}
          </section>
        </main>
      );
    }
    return (
      <main className="flex-1 overflow-y-auto">
        <header className="px-5 sm:px-8 pt-6 sm:pt-8 pb-5 border-b border-border"><h1 className="font-body font-bold text-2xl sm:text-3xl text-foreground">Collections</h1></header>
        <section className="p-5 sm:p-8 pb-24 md:pb-8">
          {collections === null ? <div className="text-muted-foreground">Loading…</div>
            : collections.length === 0 ? <div className="text-muted-foreground">No collections yet.</div>
            : <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
                {collections.map((c) => (
                  <button key={c.id} onClick={() => setOpenColl(c)}
                    className="text-left rounded-lg border border-border bg-card p-5 hover:border-primary/60 hover:-translate-y-0.5 transition cursor-pointer">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-primary mb-3"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                    <div className="font-body font-bold text-lg text-foreground">{c.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">Collection</div>
                  </button>
                ))}
              </div>}
        </section>
      </main>
    );
  }

  // ── Home / Library (books) ──
  const isHome = page !== 'library';
  const continueBooks = (books || []).filter((b) => (b.progress_sec || 0) > 0);

  return (
    <main className="flex-1 overflow-y-auto">
      <header className="px-5 sm:px-8 pt-6 sm:pt-8 pb-5 border-b border-border bg-gradient-to-b from-card to-transparent flex items-end justify-between gap-3">
        <div>
          {isHome && <div className="text-sm text-muted-foreground">{greeting()}</div>}
          <h1 className="font-body font-bold text-2xl sm:text-3xl text-foreground">{isHome ? 'Your Library' : 'Library'}</h1>
        </div>
        <AddButton onAdd={onAdd} />
      </header>

      <div className="p-5 sm:p-8 pb-24 md:pb-8 space-y-10">
        {isHome && <Librarian />}
        {books === null ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : books.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-muted-foreground mb-4">No books yet — add one to get started.</div>
            <button onClick={onAdd} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add your first book
            </button>
          </div>
        ) : (
          <>
            {isHome && continueBooks.length > 0 && (
              <section>
                <h2 className="font-body font-bold text-xl text-foreground mb-4">Continue</h2>
                <Grid books={continueBooks} onOpenBook={onOpenBook} />
              </section>
            )}
            <section>
              {isHome && <h2 className="font-body font-bold text-xl text-foreground mb-4">All books</h2>}
              <Grid books={books} onOpenBook={onOpenBook} />
            </section>
          </>
        )}
      </div>
    </main>
  );
}
