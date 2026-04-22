// BUG (BF-05): spec says deploy must refuse to run without --env. We
// silently default to "staging" instead. Fix: exit 2 with a clear error
// when --env is missing, and leave the rest of the deploy flow alone.
export function deploy(flags) {
  const env = flags.env ?? 'staging';
  console.log(`deploying to ${env}`);
  return 0;
}
