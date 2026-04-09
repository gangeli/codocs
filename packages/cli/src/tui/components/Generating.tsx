import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

interface GeneratingProps {
  message: string;
}

const SPINNER_FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

const PHASES = [
  'Reading project structure...',
  'Analyzing source files...',
  'Understanding architecture...',
  'Identifying key patterns...',
  'Drafting document...',
];

export function Generating({ message }: GeneratingProps) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [phase, setPhase] = useState(0);

  // Spinner animation
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(timer);
  }, []);

  // Elapsed timer (every second)
  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // Phase cycling (every 4 seconds)
  useEffect(() => {
    const timer = setInterval(
      () => setPhase((p) => Math.min(PHASES.length - 1, p + 1)),
      4000,
    );
    return () => clearInterval(timer);
  }, []);

  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0
    ? `${minutes}:${seconds.toString().padStart(2, '0')}`
    : `${seconds}s`;

  // Progress bar (indeterminate, bouncing)
  const barWidth = 20;
  const pos = Math.floor((elapsed * 3) % (barWidth * 2));
  const bouncePos = pos < barWidth ? pos : barWidth * 2 - pos;
  const bar = Array.from({ length: barWidth }, (_, i) =>
    i >= bouncePos && i < bouncePos + 3 ? '\u2588' : '\u2591',
  ).join('');

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box marginBottom={1}>
        <Text color="cyan">{spinner}</Text>
        <Text bold> {message}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>{bar}</Text>
        <Text dimColor>  {timeStr}</Text>
      </Box>

      <Text dimColor italic>{PHASES[phase]}</Text>
    </Box>
  );
}
