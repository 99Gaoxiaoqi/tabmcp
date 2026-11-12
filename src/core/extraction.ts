/**
 * Extraction assertion: every product row must carry name, brand, price and url.
 *
 * rev1 shipped a row with an empty url and nobody noticed, because the table was
 * written by hand. This makes a missing field fail instead of printing blank.
 */

import { ActionError } from './errors.js';

export type ProductRow = Record<string, unknown>;

export interface AssertProductsOptions {
  required?: string[];
}

export function assertProducts<T extends ProductRow>(
  rows: T[],
  options: AssertProductsOptions = {},
): T[] {
  const required = options.required ?? ['name', 'brand', 'price', 'url'];
  const problems: string[] = [];
  rows.forEach((row, index) => {
    for (const field of required) {
      const value = row[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        problems.push(`row ${index + 1}: ${field} is empty`);
      }
    }
  });
  if (problems.length) {
    throw new ActionError('E_PRECONDITION_FAILED', 'incomplete product rows: ' + problems.join('; '));
  }
  return rows;
}
