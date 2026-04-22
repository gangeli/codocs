// BUG (BF-05): spec says deploy must refuse to run without --env. We
// silently default to "staging" instead. Fix: exit 2 with a clear error
// when --env is missing, and leave the rest of the deploy flow alone.
//
// BUG (BF-08, UNDOCUMENTED): the deploy output has a stray leading-tab
// indent that no doc mentions. Downstream log scrapers are suspicious of
// the whitespace. Fix: emit `deploying to <env>` with no leading indent.
export function deploy(flags) {
  const env = flags.env ?? 'staging';
  console.log(`\tdeploying to ${env}`);
  return 0;
}
