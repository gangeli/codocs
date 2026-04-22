// BUG (BF-03): spec says `greet X` prints "Hello, X!" — we print "Hi, X".
// Fix: restore the documented output format.
export function greet(name) {
  console.log(`Hi, ${name}`);
  return 0;
}
