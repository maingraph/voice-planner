import snowball from "snowball-stemmers";

const ru = snowball.newStemmer("russian");
const en = snowball.newStemmer("english");

/** Words that carry no search signal in planner queries. */
const STOPWORDS = new Set(
  (
    "и в во на с со к ко по о об обо от до за из у для про над под при через без а но или ли же бы " +
    "не ни то это этот эта эти тот та те мой моя мои мне меня я ты вы он она они его ее её их нас нам " +
    "что как когда где какой какая какие какую который все всё был была было были будет будут есть " +
    "найди найти поищи покажи напомни поставь добавь создай запиши нужно надо мне ставил ставила " +
    "когда-то когдато какую-то какой-то там тут вот ну уже еще ещё тоже также очень просто"
  ).split(/\s+/),
);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(" ")
    .flatMap((w) => (w.includes("-") && !STOPWORDS.has(w) ? w.split("-") : [w]))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export function stem(word: string): string {
  return /[a-z]/.test(word) ? en.stem(word) : ru.stem(word);
}

export function stems(text: string): string[] {
  return tokenize(text).map(stem);
}

function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient on character trigrams — tolerant to typos and inflection leftovers. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}
