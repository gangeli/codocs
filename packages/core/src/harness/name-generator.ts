/**
 * Generate cute two-word agent names (e.g., "fuzzy-otter", "brave-parrot").
 */

import {
  uniqueNamesGenerator,
  adjectives,
  animals,
} from 'unique-names-generator';

/**
 * Generate a random two-word agent name in the form "adjective-animal".
 */
export function generateAgentName(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '-',
    length: 2,
    style: 'lowerCase',
  });
}
