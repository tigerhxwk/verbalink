// Deterministic cover gradient + initial from a book title (matches the vanilla feel).
function hash(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
export function bookGradient(title) {
  const h = hash(title);
  const a = h % 360, b = (a + 38) % 360;
  return `linear-gradient(135deg, hsl(${a} 42% 34%), hsl(${b} 48% 20%))`;
}
export function bookInitial(title) {
  const t = (title || '?').trim();
  return (t[0] || '?').toUpperCase();
}
