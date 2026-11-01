/** Russian number words → values, enough for times, offsets and dates. */
const UNITS: Record<string, number> = {
  ноль: 0, один: 1, одна: 1, одну: 1, одного: 1, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4,
  пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9,
  десять: 10, десяти: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14,
  пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  пару: 2, пара: 2, пары: 2, несколько: 3,
};
const TENS: Record<string, number> = { двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50 };

/** Ordinals in genitive/nominative for days of month and "половина третьего". */
const ORDINALS: Record<string, number> = {
  первое: 1, первого: 1, второе: 2, второго: 2, третье: 3, третьего: 3, четвертое: 4, четвертого: 4,
  пятое: 5, пятого: 5, шестое: 6, шестого: 6, седьмое: 7, седьмого: 7, восьмое: 8, восьмого: 8,
  девятое: 9, девятого: 9, десятое: 10, десятого: 10, одиннадцатое: 11, одиннадцатого: 11,
  двенадцатое: 12, двенадцатого: 12, тринадцатое: 13, тринадцатого: 13, четырнадцатое: 14, четырнадцатого: 14,
  пятнадцатое: 15, пятнадцатого: 15, шестнадцатое: 16, шестнадцатого: 16, семнадцатое: 17, семнадцатого: 17,
  восемнадцатое: 18, восемнадцатого: 18, девятнадцатое: 19, девятнадцатого: 19, двадцатое: 20, двадцатого: 20,
  тридцатое: 30, тридцатого: 30,
};

// Longest first so "двенадцать" is not cut to "две".
const alternation = (o: Record<string, number>) => Object.keys(o).sort((a, b) => b.length - a.length).join("|");
const UNIT_WORDS = alternation(UNITS);
const TEN_WORDS = alternation(TENS);
const ORDINAL_WORDS = alternation(ORDINALS);

/** Regex source matching a cardinal: digits, "двадцать пять", "три". */
export const NUM = `(?:\\d{1,4}|(?:${TEN_WORDS})(?:\\s+(?:${UNIT_WORDS}))?|${UNIT_WORDS})`;
/** Regex source matching a day ordinal: "двадцать пятое", "третьего". */
export const ORD = `(?:(?:двадцать|тридцать)\\s+(?:${ORDINAL_WORDS})|${ORDINAL_WORDS})`;

export function parseNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/ё/g, "е");
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(/\s+/);
  let total = 0;
  for (const p of parts) {
    if (p in TENS) total += TENS[p];
    else if (p in UNITS) total += UNITS[p];
    else if (p in ORDINALS) total += ORDINALS[p];
    else return null;
  }
  return total;
}
