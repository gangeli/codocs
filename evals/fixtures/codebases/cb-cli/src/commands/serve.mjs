// BUG (BF-04): spec says `--port` defaults to 3000. We default to 8080.
// Fix: change the default to 3000.
export function serve(flags) {
  const port = Number(flags.port ?? 8080);
  console.log(`serving on :${port}`);
  return 0;
}
