// Merchant normalisation. Agent path.
// The template only tidies whitespace and applies the owner's alias memory;
// agents make it smarter for the merchants they meet.

export function canonicalKey(merchant) {
  return String(merchant).toUpperCase().replace(/\s+/g, " ").trim();
}

export function normalize(transactions, { aliases = {} } = {}) {
  const table = {};
  for (const [alias, name] of Object.entries(aliases)) table[canonicalKey(alias)] = name;
  return transactions.map((t) => {
    const key = canonicalKey(t.merchant);
    return { ...t, canonical: table[key] || key };
  });
}
